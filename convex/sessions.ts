import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const DEFAULT_TTL_SECONDS = 60 * 60;
const now = () => Date.now();

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("sessions").order("desc").take(50);
  },
});

export const listForLab = query({
  args: { labId: v.id("labs") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("sessions")
      .withIndex("by_lab", (q) => q.eq("labId", args.labId))
      .order("desc")
      .take(25);
  },
});

export const listRequested = query({
  args: {
    runner: v.optional(v.union(v.literal("local"), v.literal("aws-ecs-fargate"))),
  },
  handler: async (ctx, args) => {
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

export const listActive = query({
  args: {},
  handler: async (ctx) => {
    const sessions = await ctx.db.query("sessions").order("desc").take(100);
    return sessions.filter(
      (session) =>
        !["stopped", "expired", "errored"].includes(session.status)
    );
  },
});

export const listExpired = query({
  args: {},
  handler: async (ctx) => {
    const timestamp = now();
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_expires_at", (q) => q.lt("expiresAt", timestamp))
      .order("asc")
      .take(100);

    return sessions.filter(
      (session) =>
        !["stopped", "expired", "errored"].includes(session.status)
    );
  },
});

export const listCleanupNeeded = query({
  args: { runner: v.optional(v.union(v.literal("local"), v.literal("aws-ecs-fargate"))) },
  handler: async (ctx, args) => {
    const sessions = await ctx.db.query("sessions").order("desc").take(100);
    return sessions.filter((session) => {
      if (args.runner && session.runner !== args.runner) return false;
      if (session.cleanedAt) return false;
      return session.status === "stopped" || session.status === "expired";
    });
  },
});

export const listEvents = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
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
    const session = await ctx.db.get(args.sessionId);
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
    const ttlSeconds = args.ttlSeconds ?? DEFAULT_TTL_SECONDS;

    const sessionId = await ctx.db.insert("sessions", {
      labId: args.labId,
      learnerLabel: args.learnerLabel,
      status: "requested",
      runner: args.runner ?? "local",
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

    return sessionId;
  },
});

export const markRunning = mutation({
  args: {
    sessionId: v.id("sessions"),
    workspaceUrl: v.optional(v.string()),
    previewUrl: v.optional(v.string()),
    terminalUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const timestamp = now();
    await ctx.db.patch(args.sessionId, {
      status: "running",
      workspaceUrl: args.workspaceUrl,
      previewUrl: args.previewUrl,
      terminalUrl: args.terminalUrl,
      updatedAt: timestamp,
    });
    await ctx.db.insert("sessionEvents", {
      sessionId: args.sessionId,
      level: "info",
      message: "Session runner is available",
      createdAt: timestamp,
    });
  },
});

export const updateRunnerMetadata = mutation({
  args: {
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
  },
  handler: async (ctx, args) => {
    const { sessionId, ...metadata } = args;
    await ctx.db.patch(sessionId, {
      ...metadata,
      updatedAt: now(),
    });
  },
});

export const markChecking = mutation({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const timestamp = now();
    await ctx.db.patch(args.sessionId, {
      status: "checking",
      updatedAt: timestamp,
    });
    await ctx.db.insert("sessionEvents", {
      sessionId: args.sessionId,
      level: "info",
      message: "Validation check started",
      createdAt: timestamp,
    });
  },
});

export const markStarting = mutation({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const timestamp = now();
    await ctx.db.patch(args.sessionId, {
      status: "starting",
      updatedAt: timestamp,
    });
    await ctx.db.insert("sessionEvents", {
      sessionId: args.sessionId,
      level: "info",
      message: "Session runner is starting",
      createdAt: timestamp,
    });
  },
});

export const markErrored = mutation({
  args: {
    sessionId: v.id("sessions"),
    message: v.string(),
    raw: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const timestamp = now();
    await ctx.db.patch(args.sessionId, {
      status: "errored",
      lastCheckSummary: args.message,
      updatedAt: timestamp,
    });
    await ctx.db.insert("sessionEvents", {
      sessionId: args.sessionId,
      level: "error",
      message: args.message,
      metadata: args.raw,
      createdAt: timestamp,
    });
  },
});

export const recordCheck = mutation({
  args: {
    sessionId: v.id("sessions"),
    passed: v.boolean(),
    score: v.number(),
    summary: v.string(),
    raw: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const timestamp = now();
    await ctx.db.patch(args.sessionId, {
      status: args.passed ? "passed" : "failed",
      lastCheckScore: args.score,
      lastCheckSummary: args.summary,
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
    const timestamp = now();
    await ctx.db.patch(args.sessionId, {
      status: "stopped",
      stoppedAt: timestamp,
      stopReason: args.reason ?? "Stopped by operator",
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

export const markExpired = mutation({
  args: { sessionId: v.id("sessions"), reason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const timestamp = now();
    await ctx.db.patch(args.sessionId, {
      status: "expired",
      stoppedAt: timestamp,
      stopReason: args.reason ?? "Session TTL expired",
      updatedAt: timestamp,
    });
    await ctx.db.insert("sessionEvents", {
      sessionId: args.sessionId,
      level: "warn",
      message: args.reason ?? "Session TTL expired",
      createdAt: timestamp,
    });
  },
});

export const requestCleanup = mutation({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      throw new Error("Session not found");
    }
    if (!["stopped", "expired"].includes(session.status)) {
      throw new Error("Only stopped or expired sessions can be cleaned up");
    }
    if (session.cleanedAt) {
      return;
    }

    const timestamp = now();
    await ctx.db.patch(args.sessionId, {
      cleanupRequestedAt: timestamp,
      cleanupSummary: "Cleanup requested; waiting for local runner.",
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
    sessionId: v.id("sessions"),
    summary: v.string(),
    raw: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const timestamp = now();
    await ctx.db.patch(args.sessionId, {
      cleanedAt: timestamp,
      cleanupSummary: args.summary,
      updatedAt: timestamp,
    });
    await ctx.db.insert("sessionEvents", {
      sessionId: args.sessionId,
      level: "info",
      message: args.summary,
      metadata: args.raw,
      createdAt: timestamp,
    });
  },
});
