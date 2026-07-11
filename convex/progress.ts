import { query } from "./_generated/server";
import { v } from "convex/values";
import { learnerOwnerKey } from "./access";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const ownerKey = await learnerOwnerKey(ctx);
    const records = await ctx.db.query("progressRecords").order("desc").take(200);
    return ownerKey === null ? records : records.filter((record) => record.sessionOwnerKey === ownerKey);
  },
});

export const listForLab = query({
  args: { labId: v.id("labs") },
  handler: async (ctx, args) => {
    const ownerKey = await learnerOwnerKey(ctx);
    const records = await ctx.db
      .query("progressRecords")
      .withIndex("by_lab", (q) => q.eq("labId", args.labId))
      .order("desc")
      .take(100);
    return ownerKey === null ? records : records.filter((record) => record.sessionOwnerKey === ownerKey);
  },
});
