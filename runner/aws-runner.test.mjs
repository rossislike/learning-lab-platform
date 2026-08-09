import assert from "node:assert/strict"
import test from "node:test"

import { hostedDispatchInput, startSessions } from "./aws-runner.mjs"

const artifactSha256 = "a".repeat(64)
const manifestSha256 = "b".repeat(64)
const hostedScenario = {
  approvalId: "approval-1",
  environment: "staging",
  slug: "approved-slug",
  artifactSha256,
  artifactKey: `scenarios/approved-slug/artifacts/sha256/${artifactSha256}.tar`,
  artifactSizeBytes: 4096,
  manifestSha256,
  manifestKey: `scenarios/approved-slug/manifests/sha256/${manifestSha256}.json`,
  sourceManifestSha256: "c".repeat(64),
  runtime: {
    expectedBehavior: "Approved behavior",
    expectedPorts: [{ name: "preview", containerPort: 5173, public: true }],
    packagedWorkspaceTemplatePath:
      "lab-definitions/approved-slug/workspace-template/starter",
    previewCommand: "npm run approved-preview",
    remediationFile: "src/Approved.jsx",
    ttlSeconds: 3600,
    validationCommand: "npm run approved-validation",
  },
  schemaVersion: 1,
}

test("dispatcher input comes entirely from the approved session snapshot", () => {
  const session = {
    _id: "session-1",
    labId: "mutable-lab-1",
    hostedScenario,
    ttlSeconds: 1800,
    expiresAt: 123456,
  }
  const input = hostedDispatchInput(
    session,
    "https://example.convex.cloud",
    "runner-secret",
  )

  assert.equal(input.labSlug, "approved-slug")
  assert.equal(input.runtime.validationCommand, "npm run approved-validation")
  assert.equal(
    input.runtime.packagedWorkspaceTemplatePath,
    "lab-definitions/approved-slug/workspace-template/starter",
  )
  assert.equal(input.sourceManifestSha256, "c".repeat(64))
  assert.equal(input.scenarioApprovalId, "approval-1")
  assert.equal(input.ttlSeconds, 1800)
})

test("dispatcher never queries mutable lab data before starting", async () => {
  const session = {
    _id: "session-1",
    runner: "aws-ecs-fargate",
    hostedScenario,
    ttlSeconds: 1800,
    expiresAt: 123456,
  }
  const queries = []
  const mutations = []
  const starts = []
  const client = {
    async query(reference) {
      queries.push(reference)
      if (queries.length > 1) throw new Error("unexpected mutable lab query")
      return [session]
    },
    async mutation(reference, args) {
      mutations.push([reference, args])
      return true
    },
  }
  const runner = {
    async start(input) {
      starts.push(input)
      return { resourceId: "task-1" }
    },
  }

  const count = await startSessions(
    client,
    runner,
    "https://example.convex.cloud",
    "runner-secret",
  )

  assert.equal(count, 1)
  assert.equal(queries.length, 1)
  assert.equal(starts[0].labSlug, "approved-slug")
  assert.equal(starts[0].runtime.validationCommand, "npm run approved-validation")
  assert.equal(mutations.length, 2)
})

test("dispatcher fails closed when the hosted snapshot is absent", () => {
  assert.throws(
    () =>
      hostedDispatchInput(
        { _id: "session-1", ttlSeconds: 1800, expiresAt: 123456 },
        "https://example.convex.cloud",
        "runner-secret",
      ),
    /missing its approved scenario snapshot/,
  )
})
