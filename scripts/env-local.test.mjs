import assert from "node:assert/strict"
import test from "node:test"
import { parseEnvValue } from "./env-local.mjs"

test("parses unquoted and quoted local environment values", () => {
  const contents = [
    "VITE_CONVEX_URL=https://example.convex.cloud",
    'RUNNER_SHARED_SECRET="secret=value"',
  ].join("\n")
  assert.equal(
    parseEnvValue(contents, "VITE_CONVEX_URL"),
    "https://example.convex.cloud",
  )
  assert.equal(parseEnvValue(contents, "RUNNER_SHARED_SECRET"), "secret=value")
  assert.equal(parseEnvValue(contents, "MISSING"), undefined)
})
