// Deterministic tar bundles for scenario manifest v2 directories.
//
// A bundle is what a session pod receives: the manifest, markdown, scripts,
// and (for react scenarios) the workspace/ template. Solutions and solve
// scripts are excluded so learners never receive them.

import { createHash } from "node:crypto"
import { lstat, open, readdir } from "node:fs/promises"
import { posix, relative, resolve, sep } from "node:path"

export const BUNDLE_MEDIA_TYPE = "application/vnd.learning-lab.scenario.tar"
const TAR_BLOCK_SIZE = 512
export const MAX_BUNDLE_BYTES = 64 * 1024 * 1024
export const MAX_BUNDLE_ENTRIES = 10_000

// Excluded by basename at any depth: build output and dependencies never
// belong in a bundle wherever they appear (workspaces do not ship dist/).
export const DEFAULT_EXCLUDED_DIRECTORIES = new Set(["node_modules", "dist", ".git"])
// Excluded only at the scenario root: a workspace may legitimately contain a
// `solution` directory of its own (e.g. workspace/src/solution/).
export const ROOT_EXCLUDED_DIRECTORIES = new Set(["solution"])
export const DEFAULT_EXCLUDED_FILES = new Set([".DS_Store", ".vitest-report.json"])

export function sha256(value) {
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
  writeString(header, offset, length, value.toString(8).padStart(length - 1, "0") + "\0")
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
      const { bytesRead } = await handle.read(contents, offset, contents.length - offset, offset)
      if (bytesRead === 0) throw new Error(`${description} changed while being read`)
      offset += bytesRead
    }
    const extra = Buffer.alloc(1)
    const { bytesRead: extraBytes } = await handle.read(extra, 0, 1, offset)
    if (extraBytes !== 0) throw new Error(`${description} changed while being read`)
    return contents
  } finally {
    await handle.close()
  }
}

/**
 * Walk a directory into sorted tar entries.
 * @param {string} root absolute directory
 * @param {{ maxBytes?: number, maxEntries?: number, exclude?: (archivePath: string, isDirectory: boolean) => boolean }} options
 */
export async function collectEntries(root, options = {}) {
  const limits = {
    maxBytes: options.maxBytes ?? MAX_BUNDLE_BYTES,
    maxEntries: options.maxEntries ?? MAX_BUNDLE_ENTRIES,
  }
  const exclude = options.exclude ?? (() => false)
  const state = { entryCount: 0, tarBytes: TAR_BLOCK_SIZE * 2 }
  const entries = []
  await walk(root)
  return entries

  async function walk(current) {
    const children = await readdir(current, { withFileTypes: true })
    children.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    for (const child of children) {
      const absolutePath = resolve(current, child.name)
      const archivePath = relative(root, absolutePath).split(sep).join(posix.sep)
      if (!archivePath || archivePath.startsWith("../") || archivePath.includes("/../")) {
        throw new Error(`Unsafe bundle path: ${archivePath}`)
      }
      if (Buffer.byteLength(archivePath, "utf8") > 99) {
        throw new Error(`Bundle path exceeds the portable tar limit: ${archivePath}`)
      }
      const metadata = await lstat(absolutePath)
      if (metadata.isSymbolicLink()) {
        throw new Error(`Scenario bundles cannot contain symbolic links: ${archivePath}`)
      }
      if (metadata.isDirectory()) {
        if (
          DEFAULT_EXCLUDED_DIRECTORIES.has(child.name) ||
          (current === root && ROOT_EXCLUDED_DIRECTORIES.has(child.name)) ||
          exclude(archivePath, true)
        ) {
          continue
        }
        count(TAR_BLOCK_SIZE)
        entries.push({ contents: Buffer.alloc(0), mode: 0o755, path: `${archivePath}/`, type: "5" })
        await walk(absolutePath)
        continue
      }
      if (!metadata.isFile()) {
        throw new Error(`Scenario bundles can contain only files: ${archivePath}`)
      }
      if (DEFAULT_EXCLUDED_FILES.has(child.name) || exclude(archivePath, false)) continue
      count(TAR_BLOCK_SIZE + paddedTarSize(metadata.size))
      const contents = await readBoundedFile(absolutePath, metadata.size, `Bundle file ${archivePath}`)
      entries.push({
        contents,
        mode: metadata.mode & 0o111 ? 0o755 : 0o644,
        path: archivePath,
        type: "0",
      })
    }
  }

  function count(bytes) {
    state.entryCount += 1
    state.tarBytes += bytes
    if (state.entryCount > limits.maxEntries) {
      throw new Error(`Scenario bundle exceeds ${limits.maxEntries} entries`)
    }
    if (state.tarBytes > limits.maxBytes) {
      throw new Error(`Scenario bundle exceeds ${limits.maxBytes} bytes`)
    }
  }
}

export function createTar(entries, maxBytes = MAX_BUNDLE_BYTES) {
  const parts = []
  let size = TAR_BLOCK_SIZE * 2
  for (const entry of entries) {
    const padding = (TAR_BLOCK_SIZE - (entry.contents.length % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE
    parts.push(tarHeader(entry), entry.contents, Buffer.alloc(padding))
    size += TAR_BLOCK_SIZE + entry.contents.length + padding
    if (size > maxBytes) throw new Error(`Scenario bundle exceeds ${maxBytes} bytes`)
  }
  parts.push(Buffer.alloc(TAR_BLOCK_SIZE * 2))
  return Buffer.concat(parts, size)
}

/**
 * The manifest as shipped to learners: identical to the on-disk manifest
 * except that `steps[].solve` is dropped, since the solve scripts themselves
 * are not bundled and a dangling path would only invite a look.
 */
export function sanitizeBundledManifest(manifest) {
  if (!Array.isArray(manifest.steps)) return manifest
  return {
    ...manifest,
    steps: manifest.steps.map((step) => {
      const { solve, ...learnerStep } = step
      void solve
      return learnerStep
    }),
  }
}

/**
 * Build the learner-facing bundle for a validated v2 scenario directory.
 * Solve scripts named in the manifest are excluded in addition to the
 * default exclusions (solution/ at the root, node_modules/, dist/), and the
 * bundled manifest.json is rewritten without `steps[].solve`. Everything
 * else is byte-identical to the scenario directory.
 */
export async function buildScenarioBundle(scenarioDir, manifest, options = {}) {
  const solveScripts = new Set(
    (manifest.steps ?? []).map((step) => step.solve).filter(Boolean),
  )
  const entries = await collectEntries(scenarioDir, {
    ...options,
    exclude: (archivePath, isDirectory) =>
      (!isDirectory && solveScripts.has(archivePath)) ||
      (options.exclude?.(archivePath, isDirectory) ?? false),
  })
  const manifestEntry = entries.find((entry) => entry.path === "manifest.json")
  if (manifestEntry) {
    manifestEntry.contents = Buffer.from(
      `${JSON.stringify(sanitizeBundledManifest(JSON.parse(manifestEntry.contents.toString("utf8"))), null, 2)}\n`,
      "utf8",
    )
  }
  if (entries.length === 0) throw new Error(`Scenario directory is empty: ${manifest.slug}`)
  const tar = createTar(entries, options.maxBytes)
  const digest = sha256(tar)
  return {
    tar,
    sha256: digest,
    sizeBytes: tar.length,
    key: `scenarios/${manifest.slug}/bundles/sha256/${digest}.tar`,
    entryPaths: entries.map((entry) => entry.path),
  }
}

/** Reads a bundle back into `{ path, contents }` entries (tests and tooling). */
export function readTarEntries(archive) {
  const entries = []
  for (let offset = 0; offset + TAR_BLOCK_SIZE <= archive.length; ) {
    const header = archive.subarray(offset, offset + TAR_BLOCK_SIZE)
    if (header.every((byte) => byte === 0)) break
    const path = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "")
    const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim()
    const size = Number.parseInt(sizeText || "0", 8)
    const start = offset + TAR_BLOCK_SIZE
    entries.push({ path, contents: archive.subarray(start, start + size) })
    offset = start + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE
  }
  return entries
}

export function listTarEntries(archive) {
  return readTarEntries(archive).map((entry) => entry.path)
}
