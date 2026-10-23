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
  artifactKey: `scenarios/welcome-message/bundles/sha256/${digest}.tar`,
  artifactSha256: digest,
  artifactSizeBytes: 4096,
  environment: "dev",
  manifestKey: `scenarios/welcome-message/manifests/sha256/${manifestDigest}.json`,
  manifestSha256: manifestDigest,
  slug: "welcome-message",
  sourceManifestSha256: "c".repeat(64),
  runtime: {
    kind: "react",
    ttlSeconds: 3600,
    workspace: { cwd: "/workspace", user: "learner" },
    tabs: ["terminal", "editor", "preview"],
    setup: "scripts/setup.sh",
    stepCount: 2,
    react: {
      previewPort: 5173,
      installCommand: "npm ci",
      devCommand: "npm run dev -- --host 0.0.0.0 --port 5173",
      testCommand: "npm test -- --run",
    },
  },
  schemaVersion: 2,
}

test("artifact approval requires keys derived from exact digests", () => {
  assert.doesNotThrow(() => assertScenarioArtifactApproval(approval))
  assert.throws(
    () =>
      assertScenarioArtifactApproval({
        ...approval,
        artifactKey: "scenarios/welcome-message/bundles/latest.tar",
      }),
    /does not match/,
  )
})

test("runtime contract validates the v2 manifest shape", () => {
  const terminal = {
    kind: "terminal",
    ttlSeconds: 3600,
    workspace: { cwd: "/workspace", user: "learner" },
    tabs: ["terminal"],
    stepCount: 3,
  }
  assert.doesNotThrow(() => assertScenarioArtifactApproval({ ...approval, runtime: terminal }))
  assert.throws(
    () => assertScenarioArtifactApproval({ ...approval, runtime: { ...terminal, react: approval.runtime.react } }),
    /cannot define runtime.react/,
  )
  assert.throws(
    () => assertScenarioArtifactApproval({ ...approval, runtime: { ...approval.runtime, react: undefined } }),
    /Invalid runtime.react/,
  )
  assert.throws(
    () => assertScenarioArtifactApproval({ ...approval, runtime: { ...terminal, workspace: { cwd: "../x", user: "learner" } } }),
    /Invalid runtime.workspace/,
  )
  assert.throws(
    () => assertScenarioArtifactApproval({ ...approval, runtime: { ...terminal, tabs: ["terminal", "terminal"] } }),
    /Invalid runtime.tabs/,
  )
  assert.throws(
    () => assertScenarioArtifactApproval({ ...approval, runtime: { ...terminal, setup: "../evil.sh" } }),
    /Invalid runtime.setup/,
  )
  assert.throws(
    () => assertScenarioArtifactApproval({ ...approval, schemaVersion: 1 }),
    /Invalid schemaVersion/,
  )
})

test("hosted environment fails closed when deployment configuration is absent", () => {
  assert.equal(configuredHostedEnvironment("dev"), "dev")
  assert.throws(() => configuredHostedEnvironment(undefined), /must be dev/)
  assert.throws(() => configuredHostedEnvironment("staging"), /must be dev/)
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
