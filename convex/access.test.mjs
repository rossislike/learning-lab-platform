import assert from "node:assert/strict"
import process from "node:process"
import test from "node:test"
import {
  hashAgentToken,
  learnerOwnerKey,
  requireRunnerSecret,
  requireSessionAgent,
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

test("local escape hatch is refused in the dev environment", async () => {
  const previous = process.env.ALLOW_UNAUTHENTICATED_LOCAL_MODE
  const previousEnv = process.env.HOSTED_ENVIRONMENT
  process.env.ALLOW_UNAUTHENTICATED_LOCAL_MODE = "true"
  process.env.HOSTED_ENVIRONMENT = "dev"
  await assert.rejects(
    learnerOwnerKey({ auth: { getUserIdentity: async () => null } }),
    /not allowed in the dev environment/,
  )
  // An authenticated identity is unaffected by the flag.
  assert.equal(
    await learnerOwnerKey({ auth: { getUserIdentity: async () => ({ tokenIdentifier: "issuer|a" }) } }),
    "issuer|a",
  )
  if (previous === undefined) delete process.env.ALLOW_UNAUTHENTICATED_LOCAL_MODE
  else process.env.ALLOW_UNAUTHENTICATED_LOCAL_MODE = previous
  if (previousEnv === undefined) delete process.env.HOSTED_ENVIRONMENT
  else process.env.HOSTED_ENVIRONMENT = previousEnv
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

test("session agent token authorizes only the matching, unexpired session", () => {
  const token = "a".repeat(64)
  const session = {
    agentTokenHash: hashAgentToken(token),
    agentTokenExpiresAt: Date.now() + 60_000,
  }
  assert.doesNotThrow(() => requireSessionAgent(session, token))
  assert.throws(() => requireSessionAgent(session, "b".repeat(64)), /authorization failed/)
  assert.throws(() => requireSessionAgent(session, "short"), /authorization failed/)
  assert.throws(
    () => requireSessionAgent({ ...session, agentTokenExpiresAt: Date.now() - 1 }, token),
    /expired/,
  )
  assert.throws(() => requireSessionAgent({}, token), /authorization failed/, "no token issued reads like a bad token")
  assert.notEqual(hashAgentToken(token), token)
})
