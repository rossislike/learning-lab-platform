import { query } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("courses").order("asc").collect();
  },
});

export const listModules = query({
  args: { courseId: v.optional(v.id("courses")) },
  handler: async (ctx, args) => {
    const modules = await ctx.db.query("courseModules").order("asc").collect();
    return modules
      .filter((module) => !args.courseId || module.courseId === args.courseId)
      .sort(
        (a, b) =>
          a.displayOrder - b.displayOrder ||
          a.title.localeCompare(b.title)
      );
  },
});
