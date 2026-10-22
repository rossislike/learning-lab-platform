import assert from "node:assert/strict"
import test from "node:test"

import { resolveScenarioSessionSnapshot } from "./scenarioSessionPolicy.ts"
import { assertScenarioArtifactApproval } from "./scenarioArtifactPolicy.ts"

const artifactSha256 = "a".repeat(64)
const manifestSha256 = "b".repeat(64)
const runtime = {
  expectedBehavior: "Welcome text changes",
  expectedPorts: [{ name: "preview", containerPort: 5173, public: true }],
  packagedWorkspaceTemplatePath:
    "lab-definitions/react-welcome-message/workspace-template/update-welcome-message-1",
  previewCommand: "npm run dev",
  remediationFile: "src/App.jsx",
  ttlSeconds: 3600,
  validationCommand: "npm test",
}
const approval = {
  _id: "approval-1",
  labId: "lab-1",
  slug: "react-welcome-message",
  environment: "dev",
  artifactSha256,
  artifactKey: `scenarios/react-welcome-message/artifacts/sha256/${artifactSha256}.tar`,
  artifactSizeBytes: 4096,
  manifestSha256,
  manifestKey: `scenarios/react-welcome-message/manifests/sha256/${manifestSha256}.json`,
  sourceManifestSha256: "c".repeat(64),
  runtime,
  schemaVersion: 1,
}

test("local session resolution does not consult hosted configuration or approval", async () => {
  const snapshot = await resolveScenarioSessionSnapshot({
    runner: "local",
    labId: "lab-1",
    configuredEnvironment: () => {
      throw new Error("local sessions must not read HOSTED_ENVIRONMENT")
    },
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
      runner: "kubernetes",
      labId: "lab-1",
      configuredEnvironment: () => "dev",
      validateApproval: assertScenarioArtifactApproval,
      loadLab: async () => ({
        _id: "lab-1",
        slug: "react-welcome-message",
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
    slug: "react-welcome-message",
    status: "active",
  }
  const mutableRuntime = {
    ...runtime,
    expectedPorts: runtime.expectedPorts.map((port) => ({ ...port })),
  }
  const mutableApproval = { ...approval, runtime: mutableRuntime }
  const snapshot = await resolveScenarioSessionSnapshot({
    runner: "kubernetes",
    labId: "lab-1",
    configuredEnvironment: () => "dev",
    validateApproval: assertScenarioArtifactApproval,
    loadLab: async () => lab,
    loadApproval: async () => mutableApproval,
  })

  lab.slug = "mutable-lab-slug"
  mutableRuntime.validationCommand = "mutable lab command"
  assert.equal(snapshot.approvalId, "approval-1")
  assert.equal(snapshot.environment, "dev")
  assert.equal(snapshot.slug, "react-welcome-message")
  assert.equal(snapshot.sourceManifestSha256, "c".repeat(64))
  assert.equal(snapshot.runtime.validationCommand, "npm test")
  assert.deepEqual(snapshot.runtime.expectedPorts, [
    { name: "preview", containerPort: 5173, public: true },
  ])
})

test("hosted session resolution rejects approval lab mismatch", async () => {
  await assert.rejects(
    resolveScenarioSessionSnapshot({
      runner: "kubernetes",
      labId: "lab-1",
      configuredEnvironment: () => "dev",
      validateApproval: assertScenarioArtifactApproval,
      loadLab: async () => ({
        _id: "lab-1",
        slug: "react-welcome-message",
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
      runner: "kubernetes",
      labId: "lab-1",
      configuredEnvironment: () => "dev",
      validateApproval: assertScenarioArtifactApproval,
      loadLab: async () => ({
        _id: "lab-1",
        slug: "react-welcome-message",
        status: "active",
      }),
      // Untyped test data: a legacy row whose environment is no longer in the enum.
      loadApproval: async () => ({ ...approval, environment: "staging" }),
    }),
    /does not match the requested lab/,
  )
})
