import assert from "node:assert/strict"
import process from "node:process"
import test from "node:test"
import {
  learnerOwnerKey,
  requireRunnerSecret,
  requireSessionOwner,
} from "./access.ts"

test("learner access requires authentication by default", async () => {
  const previous = process.env.ALLOW_UNAUTHENTICATED_LOCAL_MODE
  delete process.env.ALLOW_UNAUTHENTICATED_LOCAL_MODE
  await assert.rejects(
    learnerOwnerKey({ auth: { getUserIdentity: async () => null } }),
    /Authentication required/,
  )
  if (previous === undefined) delete process.env.ALLOW_UNAUTHENTICATED_LOCAL_MODE
  else process.env.ALLOW_UNAUTHENTICATED_LOCAL_MODE = previous
})

test("local escape hatch is explicit and deployment controlled", async () => {
  const previous = process.env.ALLOW_UNAUTHENTICATED_LOCAL_MODE
  process.env.ALLOW_UNAUTHENTICATED_LOCAL_MODE = "true"
  assert.equal(
    await learnerOwnerKey({ auth: { getUserIdentity: async () => null } }),
    null,
  )
  if (previous === undefined) delete process.env.ALLOW_UNAUTHENTICATED_LOCAL_MODE
  else process.env.ALLOW_UNAUTHENTICATED_LOCAL_MODE = previous
})

test("session ownership does not disclose another learner's session", async () => {
  const ctx = {
    auth: {
      getUserIdentity: async () => ({ tokenIdentifier: "issuer|learner-a" }),
    },
  }
  await assert.rejects(
    requireSessionOwner(ctx, { sessionOwnerKey: "issuer|learner-b" }),
    /Session not found/,
  )
})

test("runner functions require the configured shared secret", () => {
  const previous = process.env.RUNNER_SHARED_SECRET
  process.env.RUNNER_SHARED_SECRET = "test-runner-secret"
  assert.throws(() => requireRunnerSecret("wrong"), /authorization failed/)
  assert.doesNotThrow(() => requireRunnerSecret("test-runner-secret"))
  if (previous === undefined) delete process.env.RUNNER_SHARED_SECRET
  else process.env.RUNNER_SHARED_SECRET = previous
})
