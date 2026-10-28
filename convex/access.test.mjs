import assert from "node:assert/strict"
import process from "node:process"
import test from "node:test"
import {
  hashAgentToken,
  isOperator,
  learnerOwnerKey,
  requireOperator,
  requireRunnerSecret,
  requireSessionAgent,
  requireSessionOwner,
} from "./access.ts"

/** ctx with one users row looked up by tokenIdentifier. */
function ctxFor(tokenIdentifier, user) {
  return {
    auth: { getUserIdentity: async () => (tokenIdentifier ? { tokenIdentifier } : null) },
    db: {
      query: (table) => {
        assert.equal(table, "users")
        return {
          withIndex: (index, build) => {
            assert.equal(index, "by_token_identifier")
            const q = { eq: (field, value) => ({ field, value }) }
            const { value } = build(q)
            return { unique: async () => (user && user.tokenIdentifier === value ? user : null) }
          },
        }
      },
    },
  }
}

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
  const ctx = ctxFor("issuer|learner-a", { tokenIdentifier: "issuer|learner-a" })
  await assert.rejects(
    requireSessionOwner(ctx, { sessionOwnerKey: "issuer|learner-b" }),
    /Session not found/,
  )
})

test("operators: role on the users row, everyone in anonymous local mode, nobody else", async () => {
  const previous = process.env.ALLOW_UNAUTHENTICATED_LOCAL_MODE
  delete process.env.ALLOW_UNAUTHENTICATED_LOCAL_MODE

  const learner = ctxFor("issuer|learner-a", { tokenIdentifier: "issuer|learner-a" })
  assert.equal(await isOperator(learner), false)
  await assert.rejects(requireOperator(learner), /Operator role required/)

  const operator = ctxFor("issuer|op", { tokenIdentifier: "issuer|op", role: "operator" })
  assert.equal(await isOperator(operator), true)
  await assert.doesNotReject(requireOperator(operator))
  // Operators may administer other learners' sessions (admin Stop, status)
  // only where the call site opts in; workspace/step access stays owner-only.
  assert.deepEqual(
    await requireSessionOwner(operator, { sessionOwnerKey: "issuer|learner-b" }, { allowOperator: true }),
    { sessionOwnerKey: "issuer|learner-b" },
  )
  await assert.rejects(requireSessionOwner(operator, { sessionOwnerKey: "issuer|learner-b" }), /Session not found/)
  await assert.rejects(
    requireSessionOwner(learner, { sessionOwnerKey: "issuer|learner-b" }, { allowOperator: true }),
    /Session not found/,
  )

  const unsynced = ctxFor("issuer|new", null)
  assert.equal(await isOperator(unsynced), false)

  await assert.rejects(isOperator(ctxFor(null, null)), /Authentication required/)
  process.env.ALLOW_UNAUTHENTICATED_LOCAL_MODE = "true"
  assert.equal(await isOperator(ctxFor(null, null)), true)

  if (previous === undefined) delete process.env.ALLOW_UNAUTHENTICATED_LOCAL_MODE
  else process.env.ALLOW_UNAUTHENTICATED_LOCAL_MODE = previous
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
