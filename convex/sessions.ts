import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import {
  assertScenarioArtifactApproval,
  configuredHostedEnvironment,
} from "./scenarioArtifactPolicy";
import { resolveScenarioSessionSnapshot } from "./scenarioSessionPolicy";
import { learnerOwnerKey, requireRunnerSecret, requireSessionOwner } from "./access";
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
const MAX_TTL_SECONDS = 60 * 60;
const MAX_ACTIVE_LOCAL_SESSIONS = 5;
const LOCAL_COMPLETED_INSPECTABLE_SECONDS = 30 * 60;
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

export const listRequested = query({
  args: {
    runnerSecret: v.string(),
    runner: v.optional(v.union(v.literal("local"), v.literal("aws-ecs-fargate"))),
  },
  handler: async (ctx, args) => {
    requireRunnerSecret(args.runnerSecret);
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_status", (q) => q.eq("status", "requested"))
      .order("asc")
      .take(20);

    if (!args.runner) {
      return sessions;
    }

    return sessions.filter((session) => session.runner === args.runner);
  },
});

export const listStartable = query({
  args: {
    runnerSecret: v.string(),
    runner: v.optional(v.union(v.literal("local"), v.literal("aws-ecs-fargate"))),
  },
  handler: async (ctx, args) => {
    requireRunnerSecret(args.runnerSecret);
    const sessions = await ctx.db.query("sessions").order("asc").take(100);
    return sessions.filter((session) => {
      if (!["requested", "starting"].includes(session.status)) return false;
      if (args.runner && session.runner !== args.runner) return false;
      return true;
    });
  },
});

export const listActive = query({
  args: { runnerSecret: v.string() },
  handler: async (ctx, args) => {
    requireRunnerSecret(args.runnerSecret);
    const sessions = await ctx.db.query("sessions").order("desc").take(100);
    return sessions.filter(
      (session) =>
        !["stopped", "expired", "errored"].includes(session.status)
    );
  },
});

export const listExpired = query({
  args: { runnerSecret: v.string() },
  handler: async (ctx, args) => {
    requireRunnerSecret(args.runnerSecret);
    const timestamp = now();
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_expires_at", (q) => q.lt("expiresAt", timestamp))
      .order("asc")
      .take(100);

    return sessions.filter((session) => canExpire(session.status));
  },
});

export const listCleanupNeeded = query({
  args: { runnerSecret: v.string(), runner: v.optional(v.union(v.literal("local"), v.literal("aws-ecs-fargate"))) },
  handler: async (ctx, args) => {
    requireRunnerSecret(args.runnerSecret);
    const cleanupStatuses = ["stopping", "stopped", "expired", "errored"] as const;
    const sessions = (
      await Promise.all(
        cleanupStatuses.map((status) =>
          ctx.db
            .query("sessions")
            .withIndex("by_status", (q) => q.eq("status", status))
            .order("asc")
            .take(100)
        )
      )
    ).flat();
    return sessions.filter((session) => {
      if (args.runner && session.runner !== args.runner) return false;
      if (session.cleanedAt) return false;
      return canMarkCleaned(session.status);
    }).sort((a, b) => a.updatedAt - b.updatedAt).slice(0, 100);
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
    runner: v.optional(v.union(v.literal("local"), v.literal("aws-ecs-fargate"))),
    ttlSeconds: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const timestamp = now();
    const ttlSeconds = Math.min(args.ttlSeconds ?? DEFAULT_TTL_SECONDS, MAX_TTL_SECONDS);
    const runner = args.runner ?? "local";
    const learnerLabel = args.learnerLabel.trim();
    const identity = await ctx.auth.getUserIdentity();
    const authenticatedOwnerKey = await learnerOwnerKey(ctx);
    const ownerSubject = identity?.subject;
    if (!learnerLabel) {
      throw new Error("Learner label is required");
    }
    if (runner === "aws-ecs-fargate" && !ownerSubject) {
      throw new Error("Hosted sessions require an authenticated owner subject");
    }

    const hostedScenario = await resolveScenarioSessionSnapshot({
      runner,
      labId: args.labId,
      configuredEnvironment: configuredHostedEnvironment,
      validateApproval: assertScenarioArtifactApproval,
      loadLab: () => ctx.db.get(args.labId),
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

    if (runner === "local") {
      const activeLocalSessions = await ctx.db.query("sessions").order("desc").take(100);
      const activeCount = activeLocalSessions.filter(
        (session) =>
          session.runner === "local" &&
          isActiveSessionStatus(session.status)
      ).length;
      if (activeCount >= MAX_ACTIVE_LOCAL_SESSIONS) {
        throw new Error(
          `Local session limit reached (${MAX_ACTIVE_LOCAL_SESSIONS} active sessions)`
        );
      }
    }

    const sessionId = await ctx.db.insert("sessions", {
      labId: args.labId,
      learnerLabel,
      ...(ownerSubject ? { ownerSubject } : {}),
      sessionOwnerKey,
      status: "requested",
      runner,
      ...(hostedScenario ? { hostedScenario } : {}),
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
  },
  handler: async (ctx, args) => {
    requireRunnerSecret(args.runnerSecret);
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error("Session not found");
    if (!canUpdateRunnerMetadata(session.status)) return false;
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
            ...(session.runner === "local"
              ? {
                  expiresAt:
                    timestamp + LOCAL_COMPLETED_INSPECTABLE_SECONDS * 1000,
                }
              : {}),
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

export const markStopped = stop;

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
      updatedAt: timestamp,
    });
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
