import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import {
  assertScenarioArtifactApproval,
  configuredHostedEnvironment,
} from "./scenarioArtifactPolicy";
import { resolveScenarioSessionSnapshot } from "./scenarioSessionPolicy";
import { hashAgentToken, learnerOwnerKey, requireRunnerSecret, requireSessionOwner } from "./access";
import { isAllowedPodIp, ROUTE_ID_PATTERN } from "./accessPolicy";
import {
  ACTIVE_SESSION_STATUSES,
  canBeginStartup,
  canExpire,
  canMarkCleaned,
  canPublishStartup,
  canRequestStop,
  canUpdateRunnerMetadata,
  canUseWorkspace,
  isActiveSessionStatus,
  type SessionLifecycleStatus,
} from "./sessionLifecycle";

const DEFAULT_TTL_SECONDS = 60 * 60;
const MIN_TTL_SECONDS = 60;
// Sessions may run as long as the manifest schema allows (ttlSeconds ≤ 28800).
const MAX_TTL_SECONDS = 8 * 60 * 60;
// Cost control until quotas exist (Phase 6): concurrent active sessions.
const MAX_ACTIVE_SESSIONS = (() => {
  const parsed = Number.parseInt(process.env.MAX_ACTIVE_SESSIONS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
})();
const COMPLETED_INSPECTABLE_SECONDS = 30 * 60;
const now = () => Date.now();

type ProgressStatus = SessionLifecycleStatus;

type ProgressPatch = {
  status: ProgressStatus;
  score?: number;
  summary?: string;
  completedAt?: number;
  updatedAt: number;
};

async function patchProgressRecord(
  ctx: MutationCtx,
  sessionId: Id<"sessions">,
  patch: ProgressPatch
) {
  const [record] = await ctx.db
    .query("progressRecords")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .take(1);

  if (!record) {
    return;
  }

  await ctx.db.patch(record._id, patch);
}

/**
 * Revokes every active workspace access grant of a session (ADR 0004). Called
 * whenever a session leaves the usable states so a cookie cannot outlive the
 * pod; the gateway also re-checks grants on its own cadence.
 */
async function revokeActiveGrants(
  ctx: MutationCtx,
  sessionId: Id<"sessions">,
  reason: "stopping" | "expired" | "errored",
  timestamp: number
) {
  const grants = await ctx.db
    .query("accessGrants")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .collect();
  let revoked = 0;
  for (const grant of grants) {
    if (grant.status !== "active") continue;
    await ctx.db.patch(grant._id, { status: "revoked", revokedAt: timestamp, revokedReason: reason });
    revoked += 1;
  }
  return revoked;
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    const ownerKey = await learnerOwnerKey(ctx);
    const sessions = await ctx.db.query("sessions").order("desc").take(100);
    return sessions
      .filter((session) => ownerKey === null || session.sessionOwnerKey === ownerKey)
      .filter((session) => !session.removedFromListAt)
      .slice(0, 50);
  },
});

export const listForLab = query({
  args: { labId: v.id("labs") },
  handler: async (ctx, args) => {
    const ownerKey = await learnerOwnerKey(ctx);
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_lab", (q) => q.eq("labId", args.labId))
      .order("desc")
      .take(25);
    return ownerKey === null ? sessions : sessions.filter((session) => session.sessionOwnerKey === ownerKey);
  },
});

/**
 * Everything the dispatcher needs for one poll, with the scenario attached:
 * sessions to start or finish starting, sessions past their TTL, sessions
 * whose pod must be removed, and every active session (for orphan
 * reconciliation).
 */
export const listForDispatcher = query({
  args: { runnerSecret: v.string() },
  handler: async (ctx, args) => {
    requireRunnerSecret(args.runnerSecret);
    const timestamp = now();
    // Per-status lists are complete (`collect`), not sampled: an active
    // session missing from `active` would make the orphan reaper delete a
    // live pod. Active sessions are bounded by MAX_ACTIVE_SESSIONS; the
    // terminal statuses are filtered to the un-cleaned ones below.
    const byStatus = async (status: SessionLifecycleStatus) =>
      await ctx.db
        .query("sessions")
        .withIndex("by_status", (q) => q.eq("status", status))
        .order("asc")
        .collect();
    const [requested, starting, ...cleanupLists] = await Promise.all(
      (["requested", "starting", "stopping", "stopped", "expired", "errored"] as const).map(byStatus)
    );
    const active = (
      await Promise.all([...ACTIVE_SESSION_STATUSES].map((status) => byStatus(status)))
    ).flat();
    const expired = (
      await ctx.db
        .query("sessions")
        .withIndex("by_expires_at", (q) => q.lt("expiresAt", timestamp))
        .order("asc")
        .take(100)
    ).filter((session) => canExpire(session.status));
    const cleanup = cleanupLists
      .flat()
      .filter((session) => !session.cleanedAt && canMarkCleaned(session.status))
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .slice(0, 100);
    const withLab = async (session: Doc<"sessions">) => ({
      session,
      lab: await ctx.db.get(session.labId),
    });
    return {
      startable: await Promise.all([...requested, ...starting].map(withLab)),
      expired,
      cleanup,
      active: active.map((session) => ({
        sessionId: session._id,
        status: session.status,
        podName: session.podName ?? null,
      })),
    };
  },
});

export const listEvents = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    await requireSessionOwner(ctx, await ctx.db.get(args.sessionId));
    return await ctx.db
      .query("sessionEvents")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .order("desc")
      .take(50);
  },
});

export const getWithEvents = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const session = await requireSessionOwner(ctx, await ctx.db.get(args.sessionId));
    const events = await ctx.db
      .query("sessionEvents")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .order("desc")
      .take(50);

    return { session, events };
  },
});

export const request = mutation({
  args: {
    labId: v.id("labs"),
    learnerLabel: v.string(),
    runner: v.optional(v.literal("kubernetes")),
    ttlSeconds: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const timestamp = now();
    const runner = "kubernetes" as const;
    void args.runner;
    const learnerLabel = args.learnerLabel.trim();
    const identity = await ctx.auth.getUserIdentity();
    const authenticatedOwnerKey = await learnerOwnerKey(ctx);
    const ownerSubject = identity?.subject;
    if (!learnerLabel) {
      throw new Error("Learner label is required");
    }
    // Outside auth-disabled local development every session needs an
    // authenticated owner (ADR 0004); learnerOwnerKey already threw otherwise.
    if (!ownerSubject && process.env.ALLOW_UNAUTHENTICATED_LOCAL_MODE !== "true") {
      throw new Error("Sessions require an authenticated owner subject");
    }
    const lab = await ctx.db.get(args.labId);
    if (!lab || lab.status !== "active") {
      throw new Error("Scenario is not available");
    }
    if (lab.manifestVersion !== 2 || !lab.sourceDir) {
      throw new Error("Scenario must be re-imported (manifest v2 with sourceDir)");
    }
    // Clamp into [MIN, MAX] so a zero/negative request cannot create a
    // session that expires immediately (or never, via NaN arithmetic).
    const requestedTtl = args.ttlSeconds ?? lab.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    const ttlSeconds = Math.min(
      MAX_TTL_SECONDS,
      Math.max(MIN_TTL_SECONDS, Number.isFinite(requestedTtl) ? requestedTtl : DEFAULT_TTL_SECONDS)
    );

    const hostedScenario = await resolveScenarioSessionSnapshot({
      labId: args.labId,
      configuredEnvironment: configuredHostedEnvironment,
      validateApproval: assertScenarioArtifactApproval,
      loadLab: async () => lab,
      loadApproval: (environment) =>
        ctx.db
          .query("scenarioArtifactApprovals")
          .withIndex("by_lab_environment_status", (q) =>
            q
              .eq("labId", args.labId)
              .eq("environment", environment)
              .eq("status", "active")
          )
          .unique(),
    });

    const sessionOwnerKey =
      authenticatedOwnerKey ?? `local:${learnerLabel.toLocaleLowerCase()}`;
    const sessionsForOwner = await ctx.db
      .query("sessions")
      .withIndex("by_session_owner", (q) => q.eq("sessionOwnerKey", sessionOwnerKey))
      .collect();
    const legacyLocalSessions = ownerSubject
      ? []
      : (
          await Promise.all(
            [...ACTIVE_SESSION_STATUSES].map((status) =>
              ctx.db
                .query("sessions")
                .withIndex("by_status", (q) => q.eq("status", status))
                .collect()
            )
          )
        )
          .flat()
          .filter(
            (session) =>
              !session.sessionOwnerKey &&
              session.learnerLabel.trim().toLocaleLowerCase() ===
                learnerLabel.toLocaleLowerCase()
          );
    const activeSession = [...sessionsForOwner, ...legacyLocalSessions].find(
      (session) => isActiveSessionStatus(session.status)
    );
    if (activeSession) {
      throw new Error(
        "A session is already active for this learner. Stop or expire it before starting another."
      );
    }

    const recentSessions = await ctx.db.query("sessions").order("desc").take(200);
    const activeCount = recentSessions.filter((session) => isActiveSessionStatus(session.status)).length;
    if (activeCount >= MAX_ACTIVE_SESSIONS) {
      throw new Error(`Session limit reached (${MAX_ACTIVE_SESSIONS} active sessions)`);
    }

    const sessionId = await ctx.db.insert("sessions", {
      labId: args.labId,
      learnerLabel,
      ...(ownerSubject ? { ownerSubject } : {}),
      sessionOwnerKey,
      status: "requested",
      runner,
      ...(hostedScenario ? { hostedScenario } : {}),
      currentStep: 0,
      ttlSeconds,
      createdAt: timestamp,
      updatedAt: timestamp,
      expiresAt: timestamp + ttlSeconds * 1000,
    });

    await ctx.db.insert("sessionEvents", {
      sessionId,
      level: "info",
      message: "Session requested",
      createdAt: timestamp,
    });

    await ctx.db.insert("progressRecords", {
      labId: args.labId,
      sessionId,
      learnerLabel,
      ...(ownerSubject ? { ownerSubject } : {}),
      sessionOwnerKey,
      status: "requested",
      completedSteps: 0,
      totalSteps: lab.steps?.length ?? 0,
      startedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    return sessionId;
  },
});

export const markRunning = mutation({
  args: {
    runnerSecret: v.string(),
    sessionId: v.id("sessions"),
    workspaceUrl: v.optional(v.string()),
    previewUrl: v.optional(v.string()),
    terminalUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireRunnerSecret(args.runnerSecret);
    const timestamp = now();
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      throw new Error("Session not found");
    }
    if (!canPublishStartup(session.status)) {
      return false;
    }

    await ctx.db.patch(args.sessionId, {
      status: "running",
      workspaceUrl: args.workspaceUrl,
      previewUrl: args.previewUrl,
      terminalUrl: args.terminalUrl,
      startedAt: timestamp,
      startupDurationMs: timestamp - session.createdAt,
      updatedAt: timestamp,
    });
    await patchProgressRecord(ctx, args.sessionId, {
      status: "running",
      updatedAt: timestamp,
    });
    await ctx.db.insert("sessionEvents", {
      sessionId: args.sessionId,
      level: "info",
      message: "Session runner is available",
      createdAt: timestamp,
    });
    return true;
  },
});

// The agent token outlives the session TTL by this much so a verify that is
// running when the session expires can still record its result, and so the
// dispatcher's expiry → cleanup sequence is not racing the token. markExpired
// and markCleaned clear the token, so the grace never extends a session that
// has already been torn down.
const AGENT_TOKEN_GRACE_MS = 60 * 60 * 1000;

/**
 * Mints the session-bound agent token (ADR 0005). Returned in plaintext
 * exactly once to the runner-secret holder (the dispatcher), which injects it
 * into the session pod; Convex keeps only the hash. Re-issuing replaces the
 * previous token.
 */
export const issueAgentToken = mutation({
  args: { runnerSecret: v.string(), sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    requireRunnerSecret(args.runnerSecret);
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error("Session not found");
    if (!canUpdateRunnerMetadata(session.status)) {
      throw new Error(`Cannot issue an agent token for a ${session.status} session`);
    }
    const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");
    const timestamp = now();
    await ctx.db.patch(args.sessionId, {
      agentTokenHash: hashAgentToken(token),
      agentTokenExpiresAt: session.expiresAt + AGENT_TOKEN_GRACE_MS,
      updatedAt: timestamp,
    });
    await ctx.db.insert("sessionEvents", {
      sessionId: args.sessionId,
      level: "info",
      message: "Session agent token issued",
      createdAt: timestamp,
    });
    return { token, expiresAt: session.expiresAt + AGENT_TOKEN_GRACE_MS };
  },
});

export const updateRunnerMetadata = mutation({
  args: {
    runnerSecret: v.string(),
    sessionId: v.id("sessions"),
    workspaceUrl: v.optional(v.string()),
    previewUrl: v.optional(v.string()),
    terminalUrl: v.optional(v.string()),
    editorProvider: v.optional(v.string()),
    editorContainerName: v.optional(v.string()),
    editorPort: v.optional(v.number()),
    previewPort: v.optional(v.number()),
    toolsPort: v.optional(v.number()),
    workspacePath: v.optional(v.string()),
    runnerResourceId: v.optional(v.string()),
    routeId: v.optional(v.string()),
    podName: v.optional(v.string()),
    podIp: v.optional(v.string()),
    agentPort: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireRunnerSecret(args.runnerSecret);
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error("Session not found");
    if (!canUpdateRunnerMetadata(session.status)) return false;
    if (args.routeId !== undefined && !ROUTE_ID_PATTERN.test(args.routeId)) {
      throw new Error("Invalid routeId");
    }
    if (args.routeId !== undefined && session.routeId !== undefined && session.routeId !== args.routeId) {
      throw new Error("routeId cannot change once set");
    }
    // The gateway proxies every request on the route to podIp: only a
    // routable pod address is acceptable (never loopback or link-local).
    if (args.podIp !== undefined && !isAllowedPodIp(args.podIp)) {
      throw new Error("Invalid podIp");
    }
    const { sessionId, runnerSecret: _runnerSecret, ...metadata } = args;
    void _runnerSecret;
    await ctx.db.patch(sessionId, {
      ...metadata,
      updatedAt: now(),
    });
    return true;
  },
});

export const markChecking = mutation({
  args: { runnerSecret: v.string(), sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    requireRunnerSecret(args.runnerSecret);
    const timestamp = now();
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error("Session not found");
    if (!canUseWorkspace(session.status)) return false;
    await ctx.db.patch(args.sessionId, {
      status: "checking",
      lastCheckStartedAt: timestamp,
      updatedAt: timestamp,
    });
    await patchProgressRecord(ctx, args.sessionId, {
      status: "checking",
      updatedAt: timestamp,
    });
    await ctx.db.insert("sessionEvents", {
      sessionId: args.sessionId,
      level: "info",
      message: "Validation check started",
      createdAt: timestamp,
    });
    return true;
  },
});

export const markStarting = mutation({
  args: { runnerSecret: v.string(), sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    requireRunnerSecret(args.runnerSecret);
    const timestamp = now();
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error("Session not found");
    if (!canBeginStartup(session.status)) return false;
    await ctx.db.patch(args.sessionId, {
      status: "starting",
      updatedAt: timestamp,
    });
    await patchProgressRecord(ctx, args.sessionId, {
      status: "starting",
      updatedAt: timestamp,
    });
    await ctx.db.insert("sessionEvents", {
      sessionId: args.sessionId,
      level: "info",
      message: "Session runner is starting",
      createdAt: timestamp,
    });
    return true;
  },
});

export const markErrored = mutation({
  args: {
    runnerSecret: v.string(),
    sessionId: v.id("sessions"),
    message: v.string(),
    raw: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    requireRunnerSecret(args.runnerSecret);
    const timestamp = now();
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error("Session not found");
    if (["stopping", "stopped", "expired"].includes(session.status)) return false;
    await ctx.db.patch(args.sessionId, {
      status: "errored",
      lastCheckSummary: args.message,
      updatedAt: timestamp,
    });
    await revokeActiveGrants(ctx, args.sessionId, "errored", timestamp);
    await patchProgressRecord(ctx, args.sessionId, {
      status: "errored",
      summary: args.message,
      updatedAt: timestamp,
    });
    await ctx.db.insert("sessionEvents", {
      sessionId: args.sessionId,
      level: "error",
      message: args.message,
      metadata: args.raw,
      createdAt: timestamp,
    });
    return true;
  },
});

export const recordCheck = mutation({
  args: {
    runnerSecret: v.string(),
    sessionId: v.id("sessions"),
    passed: v.boolean(),
    score: v.number(),
    summary: v.string(),
    raw: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    requireRunnerSecret(args.runnerSecret);
    const timestamp = now();
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      throw new Error("Session not found");
    }
    if (!canUseWorkspace(session.status)) return false;
    const validationDurationMs =
      typeof session.lastCheckStartedAt === "number"
        ? timestamp - session.lastCheckStartedAt
        : undefined;

    await ctx.db.patch(args.sessionId, {
      status: args.passed ? "passed" : "failed",
      lastCheckScore: args.score,
      lastCheckSummary: args.summary,
      lastCheckCompletedAt: timestamp,
      ...(typeof validationDurationMs === "number"
        ? { lastValidationDurationMs: validationDurationMs }
        : {}),
      ...(args.passed
        ? {
            completedAt: timestamp,
            // Keep a passed workspace inspectable for a while, but never
            // extend the session past its original TTL.
            expiresAt: Math.min(
              session.expiresAt,
              timestamp + COMPLETED_INSPECTABLE_SECONDS * 1000
            ),
          }
        : {}),
      updatedAt: timestamp,
    });
    await patchProgressRecord(ctx, args.sessionId, {
      status: args.passed ? "passed" : "failed",
      score: args.score,
      summary: args.summary,
      ...(args.passed ? { completedAt: timestamp } : {}),
      updatedAt: timestamp,
    });
    await ctx.db.insert("sessionEvents", {
      sessionId: args.sessionId,
      level: args.passed ? "info" : "warn",
      message: args.summary,
      metadata: args.raw,
      createdAt: timestamp,
    });
  },
});

export const stop = mutation({
  args: { sessionId: v.id("sessions"), reason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const session = await requireSessionOwner(ctx, await ctx.db.get(args.sessionId));
    if (!canRequestStop(session.status)) return;
    if (session.status === "stopping") return;
    const timestamp = now();
    await ctx.db.patch(args.sessionId, {
      status: "stopping",
      stopReason: args.reason ?? "Stopped by operator",
      cleanupRequestedAt: session.cleanupRequestedAt ?? timestamp,
      cleanupSummary: "Stop requested; waiting for session runner cleanup.",
      updatedAt: timestamp,
    });
    await revokeActiveGrants(ctx, args.sessionId, "stopping", timestamp);
    await patchProgressRecord(ctx, args.sessionId, {
      status: "stopping",
      summary: "Stop requested; waiting for session runner cleanup.",
      updatedAt: timestamp,
    });
    await ctx.db.insert("sessionEvents", {
      sessionId: args.sessionId,
      level: "info",
      message: args.reason ?? "Stopped by operator",
      createdAt: timestamp,
    });
  },
});

export const removeFromList = mutation({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    await requireSessionOwner(ctx, await ctx.db.get(args.sessionId));
    const timestamp = now();
    await ctx.db.patch(args.sessionId, {
      removedFromListAt: timestamp,
      updatedAt: timestamp,
    });
    await ctx.db.insert("sessionEvents", {
      sessionId: args.sessionId,
      level: "info",
      message: "Session removed from recent sessions list",
      createdAt: timestamp,
    });
  },
});

export const markExpired = mutation({
  args: { runnerSecret: v.string(), sessionId: v.id("sessions"), reason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireRunnerSecret(args.runnerSecret);
    const timestamp = now();
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error("Session not found");
    if (!canExpire(session.status)) return false;
    await ctx.db.patch(args.sessionId, {
      status: "expired",
      stoppedAt: session.stoppedAt ?? timestamp,
      stopReason: args.reason ?? "Session TTL expired",
      agentTokenHash: undefined,
      agentTokenExpiresAt: undefined,
      updatedAt: timestamp,
    });
    await revokeActiveGrants(ctx, args.sessionId, "expired", timestamp);
    await patchProgressRecord(ctx, args.sessionId, {
      status: "expired",
      summary: args.reason ?? "Session TTL expired",
      updatedAt: timestamp,
    });
    await ctx.db.insert("sessionEvents", {
      sessionId: args.sessionId,
      level: "warn",
      message: args.reason ?? "Session TTL expired",
      createdAt: timestamp,
    });
    return true;
  },
});

export const requestCleanup = mutation({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const session = await requireSessionOwner(ctx, await ctx.db.get(args.sessionId));
    if (!["stopping", "stopped", "expired"].includes(session.status)) {
      throw new Error("Only stopped or expired sessions can be cleaned up");
    }
    if (session.cleanedAt) {
      return;
    }

    const timestamp = now();
    await ctx.db.patch(args.sessionId, {
      cleanupRequestedAt: session.cleanupRequestedAt ?? timestamp,
      cleanupSummary: "Cleanup requested; waiting for session runner.",
      updatedAt: timestamp,
    });
    await ctx.db.insert("sessionEvents", {
      sessionId: args.sessionId,
      level: "info",
      message: "Cleanup requested",
      createdAt: timestamp,
    });
  },
});

export const markCleaned = mutation({
  args: {
    runnerSecret: v.string(),
    sessionId: v.id("sessions"),
    summary: v.string(),
    raw: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    requireRunnerSecret(args.runnerSecret);
    const timestamp = now();
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      throw new Error("Session not found");
    }
    if (session.cleanedAt) return;
    if (!canMarkCleaned(session.status)) {
      throw new Error("Only stopping, stopped, expired, or errored sessions can be cleaned up");
    }
    const cleanupStartedAt = session.cleanupRequestedAt ?? session.stoppedAt;

    await ctx.db.patch(args.sessionId, {
      ...(session.status === "stopping"
        ? { status: "stopped" as const, stoppedAt: session.stoppedAt ?? timestamp }
        : {}),
      cleanedAt: timestamp,
      cleanupSummary: args.summary,
      agentTokenHash: undefined,
      agentTokenExpiresAt: undefined,
      ...(typeof cleanupStartedAt === "number"
        ? { cleanupDurationMs: timestamp - cleanupStartedAt }
        : {}),
      updatedAt: timestamp,
    });
    if (session.status === "stopping") {
      await patchProgressRecord(ctx, args.sessionId, {
        status: "stopped",
        summary: args.summary,
        updatedAt: timestamp,
      });
    }
    await ctx.db.insert("sessionEvents", {
      sessionId: args.sessionId,
      level: "info",
      message: args.summary,
      metadata: args.raw,
      createdAt: timestamp,
    });
  },
});
