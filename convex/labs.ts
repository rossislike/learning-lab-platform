import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { scenarioSeedData } from "./scenarioSeedData";

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
    const timestamp = now();
    const ids = [];

    for (const scenario of scenarioSeedData) {
      const existing = await ctx.db
        .query("labs")
        .withIndex("by_slug", (q) => q.eq("slug", scenario.slug))
        .unique();

      const lab = {
        ...scenario,
        tags: [...scenario.tags],
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
