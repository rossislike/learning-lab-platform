import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

const runnerValidator = v.union(v.literal("local"), v.literal("aws-ecs-fargate"));

export const heartbeat = mutation({
  args: {
    runner: runnerValidator,
    runnerId: v.string(),
    pollMs: v.number(),
    pid: v.optional(v.number()),
    hostname: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
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
