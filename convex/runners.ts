import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireRunnerSecret } from "./access";

const runnerValidator = v.literal("kubernetes");

export const heartbeat = mutation({
  args: {
    runnerSecret: v.string(),
    runner: runnerValidator,
    runnerId: v.string(),
    pollMs: v.number(),
    pid: v.optional(v.number()),
    hostname: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireRunnerSecret(args.runnerSecret);
    const now = Date.now();
    const existing = await ctx.db
      .query("runnerHeartbeats")
      .withIndex("by_runner_id", (q) => q.eq("runnerId", args.runnerId))
      .unique();

    const heartbeat = {
      runner: args.runner,
      runnerId: args.runnerId,
      pollMs: args.pollMs,
      pid: args.pid,
      hostname: args.hostname,
      lastSeenAt: now,
      updatedAt: now,
    };

    if (existing) {
      await ctx.db.patch(existing._id, heartbeat);
      return existing._id;
    }

    return await ctx.db.insert("runnerHeartbeats", {
      ...heartbeat,
      createdAt: now,
    });
  },
});

/** Learner-readable: the dashboard shows dispatcher liveness. */
export const latest = query({
  args: {
    runner: runnerValidator,
  },
  handler: async (ctx, args) => {
    const heartbeats = await ctx.db
      .query("runnerHeartbeats")
      .withIndex("by_runner", (q) => q.eq("runner", args.runner))
      .collect();

    return heartbeats.sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0] ?? null;
  },
});

/**
 * Leadership lease for the dispatcher: acquired when free, expired, or
 * already held by the caller; renewed on every poll. Returns true when the
 * caller holds the lease after the call.
 */
export const acquireLease = mutation({
  args: {
    runnerSecret: v.string(),
    name: v.string(),
    holder: v.string(),
    ttlMs: v.number(),
  },
  handler: async (ctx, args) => {
    requireRunnerSecret(args.runnerSecret);
    const timestamp = Date.now();
    const ttlMs = Math.min(Math.max(args.ttlMs, 1000), 5 * 60 * 1000);
    const existing = await ctx.db
      .query("leases")
      .withIndex("by_name", (q) => q.eq("name", args.name))
      .unique();
    if (existing && existing.holder !== args.holder && existing.expiresAt > timestamp) {
      return false;
    }
    const lease = { name: args.name, holder: args.holder, expiresAt: timestamp + ttlMs, updatedAt: timestamp };
    if (existing) await ctx.db.patch(existing._id, lease);
    else await ctx.db.insert("leases", lease);
    return true;
  },
});
