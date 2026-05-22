import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const now = () => Date.now();

const scenarioSeedData = [
  {
    slug: "react-welcome-message",
    title: "Update Welcome Message",
    summary: "Make one heading text change and verify it with a single test.",
    domainTitle: "Domain 1: React Fundamentals",
    domainSummary: "Components, JSX, props, state, events, and small UI changes",
    displayOrder: 10,
    scenarioLabel: "One-change smoke test",
    difficulty: 1,
    tags: ["react", "fundamentals", "vite", "vitest"],
    templatePath:
      "lab-definitions/react-welcome-message/workspace-template/update-welcome-message-1",
    validationCommand: "npm test -- --run --reporter=json",
    previewCommand: "npm run dev -- --host 0.0.0.0",
    status: "active" as const,
  },
  {
    slug: "react-product-dashboard",
    title: "Optimize Product Dashboard",
    summary:
      "Fix unnecessary React re-renders with memo, useMemo, and useCallback.",
    domainTitle: "Domain 2: Rendering Optimization",
    domainSummary: "Memoization, render counts, expensive calculations, and stable callbacks",
    displayOrder: 20,
    scenarioLabel: "React performance scenario",
    difficulty: 1,
    tags: ["react", "rendering-optimization", "vite", "vitest"],
    templatePath:
      "lab-definitions/react-product-dashboard/workspace-template/optimize-product-dashboard-1-unsolved",
    validationCommand: "npm test -- --run --reporter=json",
    previewCommand: "npm run dev -- --host 0.0.0.0",
    status: "active" as const,
  },
];

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
    const timestamp = now();
    const ids = [];

    for (const scenario of scenarioSeedData) {
      const existing = await ctx.db
        .query("labs")
        .withIndex("by_slug", (q) => q.eq("slug", scenario.slug))
        .unique();

      const lab = {
        ...scenario,
        updatedAt: timestamp,
      };

      if (existing) {
        await ctx.db.patch(existing._id, lab);
        ids.push(existing._id);
      } else {
        ids.push(
          await ctx.db.insert("labs", {
            ...lab,
            createdAt: timestamp,
          })
        );
      }
    }

    return ids;
  },
});

export const seedScenarios = seedReactProductDashboard;
