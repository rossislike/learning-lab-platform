import { query } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const areas = await ctx.db.query("areas").collect();
    return areas.sort(
      (a, b) => a.displayOrder - b.displayOrder || a.slug.localeCompare(b.slug)
    );
  },
});

export const getBySlug = query({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("areas")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique();
  },
});
