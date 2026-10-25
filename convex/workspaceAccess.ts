// ADR 0004 workspace access: bootstrap codes issued to the session owner,
// consumed by the gateway into host-bound access grants, and route lookups.
//
// Learner-facing: issueBootstrap. Gateway-facing (runner secret):
// consumeBootstrap, checkGrant, resolveRoute, revokeGrant.

import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireRunnerSecret, requireSessionOwner } from "./access";
import {
  BOOTSTRAP_CODE_TTL_MS,
  CODE_PATTERN,
  ENDPOINT_SCOPES,
  bootstrapRejection,
  grantExpiry,
  grantRejection,
  type EndpointScope,
} from "./accessPolicy";
import { canUseWorkspace } from "./sessionLifecycle";
import { sha256Hex, timingSafeEqualHex } from "./sha256.ts";

const now = () => Date.now();
const scopeValidator = v.union(v.literal("workspace"), v.literal("preview"));

function randomSecret() {
  return `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");
}

/**
 * Issues one-time bootstrap codes for every endpoint the session exposes.
 * Only the hashes are stored; the raw codes go back to the owner's browser
 * once, to be POSTed to each endpoint host's /__llp/bootstrap.
 */
export const issueBootstrap = mutation({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const session = await requireSessionOwner(ctx, await ctx.db.get(args.sessionId));
    if (!canUseWorkspace(session.status) || !session.routeId) {
      throw new Error("Session workspace is not available yet");
    }
    const lab = await ctx.db.get(session.labId);
    const tabs = lab?.tabs ?? ["terminal"];
    const scopes: EndpointScope[] = tabs.includes("preview") ? [...ENDPOINT_SCOPES] : ["workspace"];
    const timestamp = now();
    const expiresAt = timestamp + BOOTSTRAP_CODE_TTL_MS;
    const codes: Partial<Record<EndpointScope, string>> = {};
    for (const scope of scopes) {
      const code = randomSecret();
      codes[scope] = code;
      await ctx.db.insert("bootstrapCodes", {
        sessionId: session._id,
        routeId: session.routeId,
        scope,
        ownerKey: session.sessionOwnerKey ?? "",
        codeHash: sha256Hex(code),
        createdAt: timestamp,
        expiresAt,
      });
    }
    await ctx.db.insert("sessionEvents", {
      sessionId: session._id,
      level: "info",
      message: `Workspace bootstrap codes issued (${scopes.join(", ")})`,
      createdAt: timestamp,
    });
    return { routeId: session.routeId, scopes, codes, expiresAt };
  },
});

/**
 * Gateway: exchange a bootstrap code for an access grant + verifier. Returns
 * `{ ok: false, reason }` instead of throwing so the rejection event is
 * persisted (a thrown error rolls the mutation back); the gateway answers a
 * uniform 401 either way and only logs the reason.
 */
export const consumeBootstrap = mutation({
  args: {
    runnerSecret: v.string(),
    code: v.string(),
    routeId: v.string(),
    scope: scopeValidator,
  },
  handler: async (ctx, args) => {
    requireRunnerSecret(args.runnerSecret);
    const timestamp = now();
    if (!CODE_PATTERN.test(args.code)) return { ok: false as const, reason: "malformed" };
    const record = await ctx.db
      .query("bootstrapCodes")
      .withIndex("by_code_hash", (q) => q.eq("codeHash", sha256Hex(args.code)))
      .unique();
    const session = record ? await ctx.db.get(record.sessionId) : null;
    const rejection = bootstrapRejection(record, {
      routeId: args.routeId,
      scope: args.scope,
      now: timestamp,
      sessionUsable: Boolean(session && canUseWorkspace(session.status) && session.routeId === args.routeId),
    });
    if (rejection || !record || !session) {
      const reason = rejection ?? "unknown";
      if (record) {
        await ctx.db.insert("sessionEvents", {
          sessionId: record.sessionId,
          level: "warn",
          message: `Bootstrap rejected (${reason})`,
          createdAt: timestamp,
        });
      }
      return { ok: false as const, reason };
    }
    await ctx.db.patch(record._id, { consumedAt: timestamp });
    const verifier = randomSecret();
    const expiresAt = grantExpiry(timestamp, session.expiresAt);
    const grantId = await ctx.db.insert("accessGrants", {
      sessionId: session._id,
      routeId: args.routeId,
      scope: args.scope,
      role: "owner",
      ownerKey: record.ownerKey,
      verifierHash: sha256Hex(verifier),
      status: "active",
      issuedAt: timestamp,
      expiresAt,
    });
    await ctx.db.insert("sessionEvents", {
      sessionId: session._id,
      level: "info",
      message: `Workspace access granted (${args.scope})`,
      createdAt: timestamp,
    });
    return { ok: true as const, grantId, verifier, sessionId: session._id, expiresAt };
  },
});

/** Gateway: validate a cookie's grant on every request (cached ≤ 5 s). */
export const checkGrant = query({
  args: {
    runnerSecret: v.string(),
    grantId: v.string(),
    verifier: v.string(),
    routeId: v.string(),
    scope: scopeValidator,
  },
  handler: async (ctx, args) => {
    requireRunnerSecret(args.runnerSecret);
    const grantId = ctx.db.normalizeId("accessGrants", args.grantId);
    const record = grantId ? await ctx.db.get(grantId) : null;
    const session = record ? await ctx.db.get(record.sessionId) : null;
    const verifierMatches = Boolean(
      record && CODE_PATTERN.test(args.verifier) && timingSafeEqualHex(sha256Hex(args.verifier), record.verifierHash)
    );
    const rejection = grantRejection(record, {
      routeId: args.routeId,
      scope: args.scope,
      now: now(),
      sessionUsable: Boolean(session && canUseWorkspace(session.status) && session.routeId === args.routeId),
      verifierMatches,
    });
    if (rejection || !record) return { ok: false as const, reason: rejection ?? "unknown" };
    return { ok: true as const, sessionId: record.sessionId, expiresAt: record.expiresAt };
  },
});

/** Gateway: where does this route go? */
export const resolveRoute = query({
  args: { runnerSecret: v.string(), routeId: v.string() },
  handler: async (ctx, args) => {
    requireRunnerSecret(args.runnerSecret);
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_route", (q) => q.eq("routeId", args.routeId))
      .unique();
    if (!session) return null;
    return {
      sessionId: session._id,
      status: session.status,
      usable: canUseWorkspace(session.status) && Boolean(session.podIp),
      podIp: session.podIp ?? null,
      agentPort: session.agentPort ?? null,
      previewPort: session.previewPort ?? null,
      expiresAt: session.expiresAt,
    };
  },
});

export const revokeGrant = mutation({
  args: { runnerSecret: v.string(), grantId: v.string(), reason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireRunnerSecret(args.runnerSecret);
    const grantId = ctx.db.normalizeId("accessGrants", args.grantId);
    const record = grantId ? await ctx.db.get(grantId) : null;
    if (!record || record.status !== "active") return false;
    await ctx.db.patch(record._id, {
      status: "revoked",
      revokedAt: now(),
      revokedReason: args.reason ?? "logout",
    });
    return true;
  },
});
