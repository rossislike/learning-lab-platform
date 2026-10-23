import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import test from "node:test"
import { buildScenarioBundle, listTarEntries, readTarEntries } from "./scenario-bundle.mjs"

const manifest = {
  slug: "demo",
  steps: [{ title: "x", verify: "scripts/step1-verify.sh", solve: "scripts/step1-solve.sh" }],
}

async function fixture(extra = async () => {}) {
  const dir = await mkdtemp(resolve(tmpdir(), "llp-bundle-"))
  await mkdir(resolve(dir, "scripts"))
  await mkdir(resolve(dir, "solution/src"), { recursive: true })
  await mkdir(resolve(dir, "workspace/node_modules/x"), { recursive: true })
  await writeFile(resolve(dir, "manifest.json"), JSON.stringify(manifest))
  await writeFile(resolve(dir, "intro.md"), "# hi\n")
  await writeFile(resolve(dir, "scripts/step1-verify.sh"), "exit 1\n", { mode: 0o755 })
  await writeFile(resolve(dir, "scripts/step1-solve.sh"), "echo secret\n", { mode: 0o755 })
  await writeFile(resolve(dir, "solution/src/App.jsx"), "secret\n")
  await mkdir(resolve(dir, "workspace/src/solution"), { recursive: true })
  await writeFile(resolve(dir, "workspace/src/solution/index.js"), "learner code\n")
  await writeFile(resolve(dir, "workspace/package.json"), "{}\n")
  await writeFile(resolve(dir, "workspace/node_modules/x/index.js"), "junk\n")
  await writeFile(resolve(dir, ".DS_Store"), "junk")
  await extra(dir)
  return dir
}

test("bundles exclude solutions, solve scripts, node_modules, and junk; digests are deterministic", async () => {
  const dir = await fixture()
  try {
    const first = await buildScenarioBundle(dir, manifest)
    const second = await buildScenarioBundle(dir, manifest)
    assert.equal(first.sha256, second.sha256)
    assert.equal(first.key, `scenarios/demo/bundles/sha256/${first.sha256}.tar`)
    const entries = listTarEntries(first.tar)
    assert.deepEqual(entries, [
      "intro.md",
      "manifest.json",
      "scripts/",
      "scripts/step1-verify.sh",
      "workspace/",
      "workspace/package.json",
      "workspace/src/",
      "workspace/src/solution/",
      "workspace/src/solution/index.js",
    ])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("the bundled manifest drops steps[].solve and keeps everything else", async () => {
  const dir = await fixture()
  try {
    const bundle = await buildScenarioBundle(dir, manifest)
    const entry = readTarEntries(bundle.tar).find((item) => item.path === "manifest.json")
    const bundled = JSON.parse(entry.contents.toString("utf8"))
    assert.deepEqual(bundled, { slug: "demo", steps: [{ title: "x", verify: "scripts/step1-verify.sh" }] })
    assert.ok(!JSON.stringify(bundled).includes("solve"))
    const intro = readTarEntries(bundle.tar).find((item) => item.path === "intro.md")
    assert.equal(intro.contents.toString("utf8"), "# hi\n")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("bundles refuse symbolic links", async () => {
  const dir = await fixture(async (root) => {
    await symlink("/etc/passwd", resolve(root, "link"))
  })
  try {
    await assert.rejects(buildScenarioBundle(dir, manifest), /symbolic links/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("bundles enforce size limits", async () => {
  const dir = await fixture()
  try {
    await assert.rejects(buildScenarioBundle(dir, manifest, { maxBytes: 1024 }), /exceeds 1024 bytes/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
