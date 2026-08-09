import { createHash } from "node:crypto"
import { lstat, open, readdir, realpath } from "node:fs/promises"
import { dirname, posix, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

export const ARTIFACT_MEDIA_TYPE = "application/vnd.learning-lab.scenario.tar"
const TAR_BLOCK_SIZE = 512
export const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024
export const MAX_ARTIFACT_ENTRIES = 10_000
export const MAX_SOURCE_MANIFEST_BYTES = 1024 * 1024

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    )
  }
  return value
}

export function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`
}

function writeString(header, offset, length, value) {
  const encoded = Buffer.from(value, "utf8")
  if (encoded.length > length) throw new Error(`Tar field is too long: ${value}`)
  encoded.copy(header, offset)
}

function writeOctal(header, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, "0") + "\0"
  writeString(header, offset, length, encoded)
}

function tarHeader(entry) {
  const header = Buffer.alloc(TAR_BLOCK_SIZE)
  writeString(header, 0, 100, entry.path)
  writeOctal(header, 100, 8, entry.mode)
  writeOctal(header, 108, 8, 0)
  writeOctal(header, 116, 8, 0)
  writeOctal(header, 124, 12, entry.contents.length)
  writeOctal(header, 136, 12, 0)
  header.fill(0x20, 148, 156)
  writeString(header, 156, 1, entry.type)
  writeString(header, 257, 6, "ustar\0")
  writeString(header, 263, 2, "00")
  writeString(header, 265, 32, "root")
  writeString(header, 297, 32, "root")
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  writeString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `)
  return header
}

function isInside(root, candidate) {
  const path = relative(root, candidate)
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..")
}

function paddedTarSize(size) {
  return Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE
}

async function readBoundedFile(path, maximumBytes, description) {
  const handle = await open(path, "r")
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile()) throw new Error(`${description} must be a regular file`)
    if (metadata.size > maximumBytes) {
      throw new Error(`${description} exceeds ${maximumBytes} bytes`)
    }
    const contents = Buffer.alloc(metadata.size)
    let offset = 0
    while (offset < contents.length) {
      const { bytesRead } = await handle.read(
        contents,
        offset,
        contents.length - offset,
        offset,
      )
      if (bytesRead === 0) throw new Error(`${description} changed while being read`)
      offset += bytesRead
    }
    const extra = Buffer.alloc(1)
    const { bytesRead: extraBytes } = await handle.read(extra, 0, 1, offset)
    if (extraBytes !== 0) throw new Error(`${description} changed while being read`)
    return { contents, metadata }
  } finally {
    await handle.close()
  }
}

async function assertNoSymlinkPath(root, candidate, description) {
  const path = relative(root, candidate)
  if (!path || !isInside(root, candidate)) {
    throw new Error(`${description} must stay inside its scenario`)
  }
  let current = root
  for (const part of path.split(sep)) {
    current = resolve(current, part)
    const metadata = await lstat(current)
    if (metadata.isSymbolicLink()) {
      throw new Error(`${description} cannot use symbolic links`)
    }
  }
}

async function collectEntries(root, limits, current = root, state = {
  entryCount: 0,
  tarBytes: TAR_BLOCK_SIZE * 2,
}) {
  const entries = []
  const children = await readdir(current, { withFileTypes: true })
  children.sort((left, right) =>
    left.name === right.name ? 0 : left.name < right.name ? -1 : 1,
  )

  for (const child of children) {
    if (child.name === ".DS_Store") continue
    const absolutePath = resolve(current, child.name)
    const archivePath = relative(root, absolutePath).split(sep).join(posix.sep)
    if (!archivePath || archivePath.startsWith("../") || archivePath.includes("/../")) {
      throw new Error(`Unsafe artifact path: ${archivePath}`)
    }
    if (Buffer.byteLength(archivePath, "utf8") > 99) {
      throw new Error(`Artifact path exceeds the portable tar limit: ${archivePath}`)
    }

    const metadata = await lstat(absolutePath)
    if (metadata.isSymbolicLink()) {
      throw new Error(`Scenario artifacts cannot contain symbolic links: ${archivePath}`)
    }
    if (metadata.isDirectory()) {
      state.entryCount += 1
      state.tarBytes += TAR_BLOCK_SIZE
      if (state.entryCount > limits.maxEntries) {
        throw new Error(`Scenario artifact exceeds ${limits.maxEntries} entries`)
      }
      if (state.tarBytes > limits.maxArtifactBytes) {
        throw new Error(`Scenario artifact exceeds ${limits.maxArtifactBytes} bytes`)
      }
      entries.push({
        contents: Buffer.alloc(0),
        mode: 0o755,
        path: `${archivePath}/`,
        type: "5",
      })
      entries.push(...(await collectEntries(root, limits, absolutePath, state)))
      continue
    }
    if (!metadata.isFile()) {
      throw new Error(`Scenario artifacts can contain only files: ${archivePath}`)
    }
    state.entryCount += 1
    state.tarBytes += TAR_BLOCK_SIZE + paddedTarSize(metadata.size)
    if (state.entryCount > limits.maxEntries) {
      throw new Error(`Scenario artifact exceeds ${limits.maxEntries} entries`)
    }
    if (state.tarBytes > limits.maxArtifactBytes) {
      throw new Error(`Scenario artifact exceeds ${limits.maxArtifactBytes} bytes`)
    }
    const { contents } = await readBoundedFile(
      absolutePath,
      metadata.size,
      `Scenario artifact file ${archivePath}`,
    )
    entries.push({
      contents,
      mode: metadata.mode & 0o111 ? 0o755 : 0o644,
      path: archivePath,
      type: "0",
    })
  }

  return entries
}

function createTar(entries, maxArtifactBytes) {
  const parts = []
  let size = TAR_BLOCK_SIZE * 2
  for (const entry of entries) {
    const padding =
      (TAR_BLOCK_SIZE - (entry.contents.length % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE
    parts.push(tarHeader(entry), entry.contents, Buffer.alloc(padding))
    size += TAR_BLOCK_SIZE + entry.contents.length + padding
    if (size > maxArtifactBytes) {
      throw new Error(`Scenario artifact exceeds ${maxArtifactBytes} bytes`)
    }
  }
  parts.push(Buffer.alloc(TAR_BLOCK_SIZE * 2))
  return Buffer.concat(parts, size)
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    throw new Error(`Scenario manifest must define ${field}`)
  }
  return value
}

export async function buildScenarioArtifact(manifestPath, options = {}) {
  const limits = {
    maxArtifactBytes: options.maxArtifactBytes ?? MAX_ARTIFACT_BYTES,
    maxEntries: options.maxEntries ?? MAX_ARTIFACT_ENTRIES,
    maxManifestBytes: options.maxManifestBytes ?? MAX_SOURCE_MANIFEST_BYTES,
  }
  const resolvedManifestPath =
    manifestPath instanceof URL ? fileURLToPath(manifestPath) : manifestPath
  const manifestMetadata = await lstat(resolvedManifestPath)
  if (manifestMetadata.isSymbolicLink()) {
    throw new Error("Scenario manifest cannot be a symbolic link")
  }
  const { contents: manifestBytes } = await readBoundedFile(
    resolvedManifestPath,
    limits.maxManifestBytes,
    "Scenario manifest",
  )
  const manifest = JSON.parse(manifestBytes.toString("utf8"))
  const slug = requireString(manifest.slug, "slug")
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error(`Scenario manifest has an invalid slug: ${slug}`)
  }
  if (manifest.status !== "active") {
    throw new Error(`Only active scenarios can be published: ${slug}`)
  }
  const workspaceTemplate = requireString(
    manifest.workspaceTemplate,
    "workspaceTemplate",
  )
  if (
    !Number.isSafeInteger(manifest.ttlSeconds) ||
    manifest.ttlSeconds < 1 ||
    manifest.ttlSeconds > 8 * 60 * 60
  ) {
    throw new Error(
      "Scenario manifest ttlSeconds must be an integer from 1 through 28800",
    )
  }
  if (!Array.isArray(manifest.expectedPorts) || manifest.expectedPorts.length > 16) {
    throw new Error("Scenario manifest must define expectedPorts")
  }
  const portNames = new Set()
  for (const port of manifest.expectedPorts) {
    const name = requireString(port?.name, "expectedPorts[].name")
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(name) || portNames.has(name)) {
      throw new Error("Scenario manifest expected port names must be unique and valid")
    }
    portNames.add(name)
    if (
      !Number.isSafeInteger(port?.containerPort) ||
      port.containerPort < 1 ||
      port.containerPort > 65535
    ) {
      throw new Error(
        "Scenario manifest expectedPorts[].containerPort must be a valid TCP port",
      )
    }
    if (typeof port.public !== "boolean") {
      throw new Error("Scenario manifest expectedPorts[].public must be boolean")
    }
  }
  const labRoot = dirname(resolvedManifestPath)
  const workspaceRoot = resolve(labRoot, workspaceTemplate)
  if (!isInside(labRoot, workspaceRoot) || workspaceRoot === labRoot) {
    throw new Error(`workspaceTemplate must stay inside its scenario: ${slug}`)
  }
  await assertNoSymlinkPath(labRoot, workspaceRoot, "workspaceTemplate")
  const labRootReal = await realpath(labRoot)
  const workspaceRootReal = await realpath(workspaceRoot)
  if (!isInside(labRootReal, workspaceRootReal) || workspaceRootReal === labRootReal) {
    throw new Error(`workspaceTemplate must stay inside its scenario: ${slug}`)
  }

  if (manifest.solutionTemplate !== undefined) {
    const solutionTemplate = requireString(
      manifest.solutionTemplate,
      "solutionTemplate",
    )
    const solutionRoot = resolve(labRoot, solutionTemplate)
    if (!isInside(labRoot, solutionRoot) || solutionRoot === labRoot) {
      throw new Error(`solutionTemplate must stay inside its scenario: ${slug}`)
    }
    const solutionRootReal = await realpath(solutionRoot)
    if (
      isInside(workspaceRootReal, solutionRootReal) ||
      isInside(solutionRootReal, workspaceRootReal)
    ) {
      throw new Error("workspaceTemplate and solutionTemplate cannot overlap")
    }
  }

  const entries = await collectEntries(workspaceRoot, limits)
  if (entries.length === 0) throw new Error(`Scenario workspace is empty: ${slug}`)
  const artifact = createTar(entries, limits.maxArtifactBytes)
  const artifactSha256 = sha256(artifact)
  const artifactKey = `scenarios/${slug}/artifacts/sha256/${artifactSha256}.tar`
  const sourceManifestSha256 = sha256(manifestBytes)
  const publication = {
    artifact: {
      key: artifactKey,
      mediaType: ARTIFACT_MEDIA_TYPE,
      sha256: artifactSha256,
      sizeBytes: artifact.length,
    },
    runtime: {
      expectedBehavior: requireString(manifest.expectedBehavior, "expectedBehavior"),
      expectedPorts: manifest.expectedPorts,
      packagedWorkspaceTemplatePath: posix.join(
        "lab-definitions",
        slug,
        workspaceTemplate.split(sep).join(posix.sep),
      ),
      previewCommand: requireString(manifest.previewCommand, "previewCommand"),
      remediationFile: requireString(manifest.remediationFile, "remediationFile"),
      ttlSeconds: manifest.ttlSeconds,
      validationCommand: requireString(
        manifest.validationCommand,
        "validationCommand",
      ),
    },
    schemaVersion: 1,
    slug,
    sourceManifestSha256,
  }
  const publicationBytes = Buffer.from(canonicalJson(publication))
  const manifestSha256 = sha256(publicationBytes)
  const manifestKey = `scenarios/${slug}/manifests/sha256/${manifestSha256}.json`

  return {
    artifact,
    artifactKey,
    artifactSha256,
    artifactSizeBytes: artifact.length,
    manifest: publicationBytes,
    manifestKey,
    manifestSha256,
    runtime: publication.runtime,
    schemaVersion: publication.schemaVersion,
    slug,
    sourceManifestSha256,
  }
}

export function listTarEntries(archive) {
  const paths = []
  for (let offset = 0; offset + TAR_BLOCK_SIZE <= archive.length; ) {
    const header = archive.subarray(offset, offset + TAR_BLOCK_SIZE)
    if (header.every((byte) => byte === 0)) break
    const path = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "")
    const sizeText = header
      .subarray(124, 136)
      .toString("ascii")
      .replace(/\0.*$/, "")
      .trim()
    const size = Number.parseInt(sizeText || "0", 8)
    paths.push(path)
    offset += TAR_BLOCK_SIZE + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE
  }
  return paths
}
