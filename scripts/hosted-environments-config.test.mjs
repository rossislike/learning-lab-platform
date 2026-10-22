import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function readConfig(name) {
  return JSON.parse(readFileSync(path.join(repoRoot, "config", name), "utf8"))
}

test("hosted-environments.json lists exactly local and dev", () => {
  const config = readConfig("hosted-environments.json")
  assert.deepEqual(Object.keys(config.environments).sort(), ["dev", "local"])
  assert.equal(config.environments.local.runner, "local")
  assert.equal(config.environments.local.convexDeployment, null)
  assert.equal(config.environments.dev.runner, "kubernetes")
})

test("aws-terraform-backends.json roots are exactly accountSecurity and dev", () => {
  const config = readConfig("aws-terraform-backends.json")
  assert.deepEqual(Object.keys(config.roots).sort(), ["accountSecurity", "dev"])
  for (const root of Object.values(config.roots)) {
    assert.equal(typeof root.directory, "string")
    assert.equal(typeof root.key, "string")
  }
})
