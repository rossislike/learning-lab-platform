import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const now = () => Date.now();

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("labs").order("desc").collect();
  },
});

export const getBySlug = query({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("labs")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique();
  },
});

export const get = query({
  args: { labId: v.id("labs") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.labId);
  },
});

export const seedReactProductDashboard = mutation({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.db
      .query("labs")
      .withIndex("by_slug", (q) => q.eq("slug", "react-product-dashboard"))
      .unique();

    const lab = {
      slug: "react-product-dashboard",
      title: "Optimize Product Dashboard",
      summary:
        "Fix unnecessary React re-renders with memo, useMemo, and useCallback.",
      difficulty: 1,
      tags: ["react", "rendering-optimization", "vite", "vitest"],
      templatePath:
        "lab-definitions/react-product-dashboard/workspace-template/optimize-product-dashboard-1-unsolved",
      validationCommand: "npm test -- --run --reporter=json",
      previewCommand: "npm run dev -- --host 0.0.0.0",
      status: "active" as const,
      updatedAt: now(),
    };

    if (existing) {
      await ctx.db.patch(existing._id, lab);
      return existing._id;
    }

    return await ctx.db.insert("labs", {
      ...lab,
      createdAt: now(),
    });
  },
});
