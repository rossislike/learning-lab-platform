import assert from "node:assert/strict"
import test from "node:test"

import {
  assertScenarioArtifactApproval,
  configuredHostedEnvironment,
  planScenarioArtifactApproval,
} from "./scenarioArtifactPolicy.ts"

const digest = "a".repeat(64)
const manifestDigest = "b".repeat(64)
const approval = {
  artifactKey: `scenarios/react-welcome-message/artifacts/sha256/${digest}.tar`,
  artifactSha256: digest,
  artifactSizeBytes: 4096,
  environment: "staging",
  manifestKey: `scenarios/react-welcome-message/manifests/sha256/${manifestDigest}.json`,
  manifestSha256: manifestDigest,
  slug: "react-welcome-message",
  sourceManifestSha256: "c".repeat(64),
  runtime: {
    expectedBehavior: "Welcome text changes",
    expectedPorts: [
      { name: "preview", containerPort: 5173, public: true },
    ],
    packagedWorkspaceTemplatePath:
      "lab-definitions/react-welcome-message/workspace-template/update-welcome-message-1",
    previewCommand: "npm run dev",
    remediationFile: "src/App.jsx",
    ttlSeconds: 3600,
    validationCommand: "npm test",
  },
  schemaVersion: 1,
}

test("artifact approval requires keys derived from exact digests", () => {
  assert.doesNotThrow(() => assertScenarioArtifactApproval(approval))
  assert.throws(
    () =>
      assertScenarioArtifactApproval({
        ...approval,
        artifactKey: "scenarios/react-welcome-message/artifacts/latest.tar",
      }),
    /does not match/,
  )
})

test("hosted environment fails closed when deployment configuration is absent", () => {
  assert.equal(configuredHostedEnvironment("production"), "production")
  assert.throws(() => configuredHostedEnvironment(undefined), /must be staging or production/)
})

test("artifact approval planning retains history and is idempotent", () => {
  const old = {
    _id: "old-approval",
    artifactSha256: "d".repeat(64),
    manifestSha256: "e".repeat(64),
  }
  const unchanged = { _id: "same-approval", ...approval }

  assert.deepEqual(planScenarioArtifactApproval([unchanged], approval), {
    unchangedId: "same-approval",
    supersedeIds: ["same-approval"],
  })
  assert.deepEqual(planScenarioArtifactApproval([old], approval), {
    unchangedId: undefined,
    supersedeIds: ["old-approval"],
  })
  assert.deepEqual(planScenarioArtifactApproval([old, unchanged], approval), {
    unchangedId: undefined,
    supersedeIds: ["old-approval", "same-approval"],
  })
})
