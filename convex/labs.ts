import { internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { requireOperator } from "./access";
import { v } from "convex/values";
import { areaSeedData, scenarioSeedData } from "./scenarioSeedData";

const now = () => Date.now();

export const list = query({
  args: {},
  handler: async (ctx) => {
    // Reseeding archives scenarios that left the catalog instead of deleting
    // them (sessions keep a valid labId); the dashboard must not list those.
    const labs = await ctx.db.query("labs").order("desc").collect();
    return labs.filter((lab) => lab.status === "active");
  },
});

export const listByArea = query({
  args: { area: v.string() },
  handler: async (ctx, args) => {
    const labs = await ctx.db
      .query("labs")
      .withIndex("by_area", (q) => q.eq("area", args.area))
      .collect();
    return labs
      .filter((lab) => lab.status === "active")
      .sort(
        (a, b) =>
          (a.displayOrder ?? 999) - (b.displayOrder ?? 999) ||
          a.title.localeCompare(b.title)
      );
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

/**
 * Upserts every area and scenario from the generated seed data
 * (`npm run scenarios:import`). Scenarios that are no longer in the seed are
 * archived rather than deleted so existing sessions keep a valid labId.
 */
async function seedCatalog(ctx: MutationCtx) {
    const timestamp = now();
    const ids: string[] = [];

    for (const area of areaSeedData) {
      const existing = await ctx.db
        .query("areas")
        .withIndex("by_slug", (q) => q.eq("slug", area.slug))
        .unique();
      const record = { ...area, updatedAt: timestamp };
      if (existing) {
        await ctx.db.patch(existing._id, record);
      } else {
        await ctx.db.insert("areas", { ...record, createdAt: timestamp });
      }
    }

    const seededSlugs = new Set<string>();
    for (const scenario of scenarioSeedData) {
      seededSlugs.add(scenario.slug);
      const existing = await ctx.db
        .query("labs")
        .withIndex("by_slug", (q) => q.eq("slug", scenario.slug))
        .unique();

      const lab = {
        ...scenario,
        tags: [...scenario.tags],
        tabs: [...scenario.tabs],
        steps: scenario.steps.map((step) => ({ ...step })),
        updatedAt: timestamp,
      };

      if (existing) {
        await ctx.db.replace(existing._id, {
          ...lab,
          createdAt: existing.createdAt,
        });
        ids.push(existing._id);
      } else {
        ids.push(await ctx.db.insert("labs", { ...lab, createdAt: timestamp }));
      }
    }

    const all = await ctx.db.query("labs").collect();
    for (const lab of all) {
      if (!seededSlugs.has(lab.slug) && lab.status !== "archived") {
        await ctx.db.patch(lab._id, { status: "archived", updatedAt: timestamp });
      }
    }

    return ids;
}

/** Seed/refresh the catalog from the imported manifests — operators only (the admin page). */
export const seedScenarios = mutation({
  args: {},
  handler: async (ctx) => {
    await requireOperator(ctx);
    return await seedCatalog(ctx);
  },
});

/** The same seed for the deploy script (`npx convex run labs:seedCatalogInternal`), which has no learner identity. */
export const seedCatalogInternal = internalMutation({
  args: {},
  handler: async (ctx) => seedCatalog(ctx),
});
