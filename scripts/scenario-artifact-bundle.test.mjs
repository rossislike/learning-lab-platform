import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import test from "node:test"
import { promisify } from "node:util"

import {
  buildScenarioArtifact,
  listTarEntries,
} from "./scenario-artifact-bundle.mjs"

const welcomeManifest = new URL(
  "../lab-definitions/react-welcome-message/manifest.json",
  import.meta.url,
)
const execute = promisify(execFile)

function manifest(overrides = {}) {
  return {
    slug: "artifact-test",
    status: "active",
    workspaceTemplate: "workspace",
    solutionTemplate: "solution",
    expectedBehavior: "A bounded starter",
    expectedPorts: [],
    previewCommand: "npm run dev",
    remediationFile: "src/App.jsx",
    ttlSeconds: 3600,
    validationCommand: "npm test",
    ...overrides,
  }
}

test("scenario artifact packaging is deterministic and excludes solutions", async (context) => {
  const first = await buildScenarioArtifact(welcomeManifest)
  const second = await buildScenarioArtifact(welcomeManifest)

  assert.equal(first.artifactSha256, second.artifactSha256)
  assert.equal(first.manifestSha256, second.manifestSha256)
  assert.deepEqual(first.artifact, second.artifact)
  assert.match(
    first.artifactKey,
    new RegExp(`^scenarios/react-welcome-message/artifacts/sha256/${first.artifactSha256}\\.tar$`),
  )
  assert.match(
    first.manifestKey,
    new RegExp(`^scenarios/react-welcome-message/manifests/sha256/${first.manifestSha256}\\.json$`),
  )

  const entries = listTarEntries(first.artifact)
  assert.ok(entries.includes("src/App.jsx"))
  assert.ok(entries.includes("tests/App.test.jsx"))
  assert.equal(entries.some((entry) => entry.includes("update-welcome-message-2")), false)

  const publishedManifest = JSON.parse(first.manifest.toString("utf8"))
  assert.equal(publishedManifest.artifact.sha256, first.artifactSha256)
  assert.equal(publishedManifest.artifact.sizeBytes, first.artifact.length)
  assert.equal(publishedManifest.solutionTemplate, undefined)
  assert.equal(publishedManifest.authoring, undefined)

  const root = await mkdtemp(resolve(tmpdir(), "llp-artifact-tar-"))
  context.after(() => rm(root, { recursive: true, force: true }))
  const archivePath = resolve(root, "scenario.tar")
  await writeFile(archivePath, first.artifact)
  const { stdout } = await execute("tar", ["-tf", archivePath])
  assert.match(stdout, /^src\/$/m)
  assert.match(stdout, /^src\/App\.jsx$/m)
  const extracted = resolve(root, "extracted")
  await mkdir(extracted)
  await execute("tar", ["-xf", archivePath, "-C", extracted])
  assert.equal(
    await readFile(resolve(extracted, "src/App.jsx"), "utf8"),
    await readFile(
      new URL(
        "../lab-definitions/react-welcome-message/workspace-template/update-welcome-message-1/src/App.jsx",
        import.meta.url,
      ),
      "utf8",
    ),
  )
})

test("scenario artifacts reject symbolic links", async (context) => {
  const root = await mkdtemp(resolve(tmpdir(), "llp-artifact-link-"))
  context.after(() => rm(root, { recursive: true, force: true }))
  const workspace = resolve(root, "workspace")
  await writeFile(resolve(root, "outside.txt"), "outside")
  await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace))
  await symlink(resolve(root, "outside.txt"), resolve(workspace, "link.txt"))
  await writeFile(
    resolve(root, "manifest.json"),
    JSON.stringify({
      ...manifest({ slug: "unsafe-link" }),
      solutionTemplate: undefined,
    }),
  )

  await assert.rejects(
    buildScenarioArtifact(resolve(root, "manifest.json")),
    /cannot contain symbolic links/,
  )
})

test("scenario artifacts reject a symlink used as the workspace root", async (context) => {
  const root = await mkdtemp(resolve(tmpdir(), "llp-artifact-root-link-"))
  context.after(() => rm(root, { recursive: true, force: true }))
  const external = resolve(root, "external")
  await mkdir(external)
  await writeFile(resolve(external, "secret.txt"), "external")
  await symlink(external, resolve(root, "workspace"))
  await mkdir(resolve(root, "solution"))
  await writeFile(resolve(root, "manifest.json"), JSON.stringify(manifest()))

  await assert.rejects(
    buildScenarioArtifact(resolve(root, "manifest.json")),
    /workspaceTemplate cannot use symbolic links/,
  )
})

test("scenario artifacts reject starter and solution overlap", async (context) => {
  const root = await mkdtemp(resolve(tmpdir(), "llp-artifact-overlap-"))
  context.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(resolve(root, "workspace/solution"), { recursive: true })
  await writeFile(resolve(root, "workspace/starter.txt"), "starter")
  await writeFile(resolve(root, "workspace/solution/answer.txt"), "answer")
  await writeFile(
    resolve(root, "manifest.json"),
    JSON.stringify(manifest({ solutionTemplate: "workspace/solution" })),
  )

  await assert.rejects(
    buildScenarioArtifact(resolve(root, "manifest.json")),
    /cannot overlap/,
  )
})

test("scenario artifact limits reject cumulative size and entry count", async (context) => {
  const root = await mkdtemp(resolve(tmpdir(), "llp-artifact-limits-"))
  context.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(resolve(root, "workspace"))
  await mkdir(resolve(root, "solution"))
  await writeFile(resolve(root, "workspace/one.txt"), Buffer.alloc(1024))
  await writeFile(resolve(root, "workspace/two.txt"), "two")
  await writeFile(resolve(root, "manifest.json"), JSON.stringify(manifest()))

  await assert.rejects(
    buildScenarioArtifact(resolve(root, "manifest.json"), {
      maxArtifactBytes: 2048,
    }),
    /exceeds 2048 bytes/,
  )
  await assert.rejects(
    buildScenarioArtifact(resolve(root, "manifest.json"), { maxEntries: 1 }),
    /exceeds 1 entries/,
  )
})
