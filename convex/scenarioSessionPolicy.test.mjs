import assert from "node:assert/strict"
import test from "node:test"

import { resolveScenarioSessionSnapshot } from "./scenarioSessionPolicy.ts"
import { assertScenarioArtifactApproval } from "./scenarioArtifactPolicy.ts"

const artifactSha256 = "a".repeat(64)
const manifestSha256 = "b".repeat(64)
const runtime = {
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
  }
const approval = {
  _id: "approval-1",
  labId: "lab-1",
  slug: "welcome-message",
  environment: "dev",
  artifactSha256,
  artifactKey: `scenarios/welcome-message/bundles/sha256/${artifactSha256}.tar`,
  artifactSizeBytes: 4096,
  manifestSha256,
  manifestKey: `scenarios/welcome-message/manifests/sha256/${manifestSha256}.json`,
  sourceManifestSha256: "c".repeat(64),
  runtime,
  schemaVersion: 2,
}

test("local environment sessions carry no approval snapshot", async () => {
  const snapshot = await resolveScenarioSessionSnapshot({
    labId: "lab-1",
    configuredEnvironment: () => "local",
    validateApproval: assertScenarioArtifactApproval,
    loadLab: async () => {
      throw new Error("local sessions must not load hosted lab state")
    },
    loadApproval: async () => {
      throw new Error("local sessions must not load approvals")
    },
  })
  assert.equal(snapshot, undefined)
})

test("hosted session resolution fails closed without an active approval", async () => {
  await assert.rejects(
    resolveScenarioSessionSnapshot({
      labId: "lab-1",
      configuredEnvironment: () => "dev",
      validateApproval: assertScenarioArtifactApproval,
      loadLab: async () => ({
        _id: "lab-1",
        slug: "welcome-message",
        status: "active",
      }),
      loadApproval: async () => null,
    }),
    /not approved for this environment/,
  )
})

test("hosted session resolution snapshots the complete approved contract", async () => {
  const lab = {
    _id: "lab-1",
    slug: "welcome-message",
    status: "active",
  }
  const mutableRuntime = {
    ...runtime,
    tabs: [...runtime.tabs],
    react: { ...runtime.react },
  }
  const mutableApproval = { ...approval, runtime: mutableRuntime }
  const snapshot = await resolveScenarioSessionSnapshot({
    labId: "lab-1",
    configuredEnvironment: () => "dev",
    validateApproval: assertScenarioArtifactApproval,
    loadLab: async () => lab,
    loadApproval: async () => mutableApproval,
  })

  lab.slug = "mutable-lab-slug"
  mutableRuntime.react.testCommand = "mutable lab command"
  mutableRuntime.tabs.push("preview")
  assert.equal(snapshot.approvalId, "approval-1")
  assert.equal(snapshot.environment, "dev")
  assert.equal(snapshot.slug, "welcome-message")
  assert.equal(snapshot.sourceManifestSha256, "c".repeat(64))
  assert.equal(snapshot.runtime.react.testCommand, "npm test -- --run")
  assert.deepEqual(snapshot.runtime.tabs, ["terminal", "editor", "preview"])
})

test("hosted session resolution rejects approval lab mismatch", async () => {
  await assert.rejects(
    resolveScenarioSessionSnapshot({
      labId: "lab-1",
      configuredEnvironment: () => "dev",
      validateApproval: assertScenarioArtifactApproval,
      loadLab: async () => ({
        _id: "lab-1",
        slug: "welcome-message",
        status: "active",
      }),
      loadApproval: async () => ({ ...approval, labId: "lab-2" }),
    }),
    /does not match the requested lab/,
  )
})

test("hosted session resolution rejects approval environment mismatch", async () => {
  await assert.rejects(
    resolveScenarioSessionSnapshot({
      labId: "lab-1",
      configuredEnvironment: () => "dev",
      validateApproval: assertScenarioArtifactApproval,
      loadLab: async () => ({
        _id: "lab-1",
        slug: "welcome-message",
        status: "active",
      }),
      // Untyped test data: a legacy row whose environment is no longer in the enum.
      loadApproval: async () => ({ ...approval, environment: "staging" }),
    }),
    /does not match the requested lab/,
  )
})
