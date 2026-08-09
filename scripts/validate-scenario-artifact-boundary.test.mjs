import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const schema = await readFile(new URL("../convex/schema.ts", import.meta.url), "utf8")
const sessions = await readFile(
  new URL("../convex/sessions.ts", import.meta.url),
  "utf8",
)
const approvals = await readFile(
  new URL("../convex/scenarioArtifacts.ts", import.meta.url),
  "utf8",
)
const sessionPolicy = await readFile(
  new URL("../convex/scenarioSessionPolicy.ts", import.meta.url),
  "utf8",
)
const dispatcher = await readFile(
  new URL("../runner/aws-runner.mjs", import.meta.url),
  "utf8",
)
const terraform = await readFile(
  new URL("../infra/aws/modules/hosted-runner/main.tf", import.meta.url),
  "utf8",
)

test("Convex retains environment-specific artifact approval history", () => {
  assert.match(schema, /scenarioArtifactApprovals: defineTable/)
  assert.match(schema, /by_lab_environment_status/)
  assert.match(approvals, /internalMutation/)
  assert.match(approvals, /status: "superseded"/)
  assert.match(approvals, /status: "active"/)
  assert.doesNotMatch(approvals, /export const approve = mutation/)
})

test("hosted requests fail closed and store the complete approved snapshot", () => {
  assert.match(
    sessionPolicy,
    /Hosted scenario artifact is not approved for this environment/,
  )
  for (const field of [
    "hostedScenario",
    "approvalId",
    "sourceManifestSha256",
    "runtime",
    "schemaVersion",
  ]) {
    assert.match(schema, new RegExp(field))
    assert.match(sessionPolicy + sessions, new RegExp(field))
  }
})

test("AWS dispatcher uses only the complete session snapshot", () => {
  assert.match(dispatcher, /session\.hostedScenario/)
  assert.doesNotMatch(dispatcher, /api\.labs\.get|lab\.templatePath|lab\.validationCommand/)
})

test("artifact bucket rejects writes without create-only preconditions", () => {
  for (const sid of [
    "DenyScenarioWritesWithoutCreatePrecondition",
    "DenyScenarioWritesWithoutWildcardPrecondition",
  ]) {
    assert.match(terraform, new RegExp(`sid\\s+= "${sid}"`))
  }
  assert.match(terraform, /variable = "s3:if-none-match"/)
  assert.match(terraform, /resources = \["\$\{local\.artifact_bucket\.arn\}\/scenarios\/\*"\]/)
  assert.match(terraform, /sid\s+= "DenyScenarioArtifactDeletion"/)
  assert.match(terraform, /"s3:DeleteObject", "s3:DeleteObjectVersion"/)
  assert.match(terraform, /var\.allow_scenario_artifact_deletion \? \[\] : \[1\]/)
})
