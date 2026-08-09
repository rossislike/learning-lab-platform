import assert from "node:assert/strict"
import { access, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import test from "node:test"
import { packageLearnerTemplates } from "./package-learner-templates.mjs"

const sourceRoot = resolve(
  new URL("../lab-definitions", import.meta.url).pathname,
)

test("packager includes every starter and excludes manifests and solutions", async (t) => {
  const destinationRoot = await mkdtemp(
    resolve(tmpdir(), "learning-lab-templates-"),
  )
  t.after(() => rm(destinationRoot, { recursive: true, force: true }))

  const count = await packageLearnerTemplates(sourceRoot, destinationRoot)
  assert.equal(count, 4)

  for (const labName of [
    "react-button-label",
    "react-empty-state",
    "react-product-dashboard",
    "react-welcome-message",
  ]) {
    const manifest = JSON.parse(
      await readFile(resolve(sourceRoot, labName, "manifest.json"), "utf8"),
    )
    await access(resolve(destinationRoot, labName, manifest.workspaceTemplate))
    await assert.rejects(
      access(resolve(destinationRoot, labName, manifest.solutionTemplate)),
    )
    await assert.rejects(access(resolve(destinationRoot, labName, "manifest.json")))
  }
})
