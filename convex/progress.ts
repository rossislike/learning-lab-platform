import { query } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("progressRecords").order("desc").take(200);
  },
});

export const listForLab = query({
  args: { labId: v.id("labs") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("progressRecords")
      .withIndex("by_lab", (q) => q.eq("labId", args.labId))
      .order("desc")
      .take(100);
  },
});
