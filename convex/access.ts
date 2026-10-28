import type { Doc } from "./_generated/dataModel";
import type { QueryCtx, MutationCtx } from "./_generated/server";
// The explicit `.ts` extension lets Node's test runner import this module
// without a loader (tsconfig has `allowImportingTsExtensions`). ROADMAP Phase 3
// confirms that `npx convex dev` bundles it; if not, drop the extension here and
// the tsconfig flag.
import { sha256Hex, timingSafeEqualHex } from "./sha256.ts";

type Ctx = QueryCtx | MutationCtx;

export async function learnerOwnerKey(ctx: Ctx) {
  const identity = await ctx.auth.getUserIdentity();
  if (identity) return identity.tokenIdentifier;
  if (process.env.ALLOW_UNAUTHENTICATED_LOCAL_MODE === "true") {
    // The escape hatch exists for local development only (ADR 0007): a dev
    // deployment that carries it would expose every learner's sessions.
    if (process.env.HOSTED_ENVIRONMENT === "dev") {
      throw new Error("Unauthenticated local mode is not allowed in the dev environment");
    }
    return null;
  }
  throw new Error("Authentication required");
}

/** The signed-in learner's account row, or null (anonymous local mode, or not synced yet). */
export async function currentUser(ctx: Ctx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  return await ctx.db
    .query("users")
    .withIndex("by_token_identifier", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
    .unique();
}

/**
 * Operators administer the deployment (seed the catalog, see and stop every
 * session). The role lives on the users row and is granted from the CLI
 * (`users:grantOperator`). In anonymous local mode everyone is an operator.
 */
export async function isOperator(ctx: Ctx) {
  const ownerKey = await learnerOwnerKey(ctx);
  if (ownerKey === null) return true;
  const user = await currentUser(ctx);
  return user?.role === "operator";
}

export async function requireOperator(ctx: Ctx) {
  if (!(await isOperator(ctx))) throw new Error("Operator role required");
}

/**
 * The session's owner (or, with `allowOperator`, an operator); anyone else
 * gets "not found". Operator access is opt-in per call site and limited to
 * administration (stop, read status/events): operators must never get
 * workspace access to, or act as, a learner in someone else's session.
 */
export async function requireSessionOwner(
  ctx: Ctx,
  session: Doc<"sessions"> | null,
  { allowOperator = false }: { allowOperator?: boolean } = {},
) {
  if (!session) throw new Error("Session not found");
  const ownerKey = await learnerOwnerKey(ctx);
  if (ownerKey !== null && session.sessionOwnerKey !== ownerKey && !(allowOperator && (await isOperator(ctx)))) {
    throw new Error("Session not found");
  }
  return session;
}

export function requireRunnerSecret(value: string) {
  const expected = process.env.RUNNER_SHARED_SECRET;
  if (!expected || value !== expected) throw new Error("Runner authorization failed");
}

/**
 * Authorizes a session agent by its session-bound token (ADR 0005). Convex
 * stores only the token's SHA-256 and an expiry; the dispatcher receives the
 * plaintext once from `sessions.issueAgentToken` and injects it into the pod.
 */
export function requireSessionAgent(session: Doc<"sessions">, token: string) {
  // Same message as a bad token: a caller must not learn whether a token was
  // ever issued for this session.
  if (!session.agentTokenHash || !session.agentTokenExpiresAt) {
    throw new Error("Session agent authorization failed");
  }
  if (Date.now() > session.agentTokenExpiresAt) {
    throw new Error("Session agent token has expired");
  }
  if (typeof token !== "string" || token.length < 32) {
    throw new Error("Session agent authorization failed");
  }
  if (!timingSafeEqualHex(sha256Hex(token), session.agentTokenHash)) {
    throw new Error("Session agent authorization failed");
  }
}

export function hashAgentToken(token: string) {
  return sha256Hex(token);
}
