import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { scenarioSeedData } from "./scenarioSeedData";

const now = () => Date.now();
const DEFAULT_COURSE = {
  slug: "react-labs",
  title: "React Labs",
  summary: "Self-serve React coding exercises.",
};

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
    const existingCourse = await ctx.db
      .query("courses")
      .withIndex("by_slug", (q) => q.eq("slug", DEFAULT_COURSE.slug))
      .unique();
    const courseId = existingCourse
      ? existingCourse._id
      : await ctx.db.insert("courses", {
          ...DEFAULT_COURSE,
          createdAt: timestamp,
          updatedAt: timestamp,
        });

    if (existingCourse) {
      await ctx.db.patch(courseId, {
        ...DEFAULT_COURSE,
        updatedAt: timestamp,
      });
    }

    for (const scenario of scenarioSeedData) {
      const moduleSlug = slugFor(scenario.domainTitle ?? "React Scenarios");
      const existingModule = await ctx.db
        .query("courseModules")
        .withIndex("by_slug", (q) => q.eq("slug", moduleSlug))
        .unique();
      const module = {
        courseId,
        slug: moduleSlug,
        title: scenario.domainTitle ?? "React Scenarios",
        summary: scenario.domainSummary ?? "Hands-on React practice scenarios.",
        displayOrder: scenario.displayOrder ?? 999,
        updatedAt: timestamp,
      };
      const moduleId = existingModule
        ? existingModule._id
        : await ctx.db.insert("courseModules", {
            ...module,
            createdAt: timestamp,
          });

      if (existingModule) {
        await ctx.db.patch(moduleId, module);
      }

      const existing = await ctx.db
        .query("labs")
        .withIndex("by_slug", (q) => q.eq("slug", scenario.slug))
        .unique();

      const lab = {
        ...scenario,
        courseId,
        moduleId,
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

function slugFor(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
