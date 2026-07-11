import type { Doc } from "./_generated/dataModel";
import type { QueryCtx, MutationCtx } from "./_generated/server";

type Ctx = QueryCtx | MutationCtx;

export async function learnerOwnerKey(ctx: Ctx) {
  const identity = await ctx.auth.getUserIdentity();
  if (identity) return identity.tokenIdentifier;
  if (process.env.ALLOW_UNAUTHENTICATED_LOCAL_MODE === "true") return null;
  throw new Error("Authentication required");
}

export async function requireSessionOwner(ctx: Ctx, session: Doc<"sessions"> | null) {
  if (!session) throw new Error("Session not found");
  const ownerKey = await learnerOwnerKey(ctx);
  if (ownerKey !== null && session.sessionOwnerKey !== ownerKey) {
    throw new Error("Session not found");
  }
  return session;
}

export function requireRunnerSecret(value: string) {
  const expected = process.env.RUNNER_SHARED_SECRET;
  if (!expected || value !== expected) throw new Error("Runner authorization failed");
}
