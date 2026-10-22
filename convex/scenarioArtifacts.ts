import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

import {
  assertScenarioArtifactApproval,
  configuredHostedEnvironment,
  planScenarioArtifactApproval,
} from "./scenarioArtifactPolicy";

const environmentValidator = v.literal("dev");
const runtimeValidator = v.object({
  expectedBehavior: v.string(),
  expectedPorts: v.array(
    v.object({
      name: v.string(),
      containerPort: v.number(),
      public: v.boolean(),
    })
  ),
  packagedWorkspaceTemplatePath: v.string(),
  previewCommand: v.string(),
  remediationFile: v.string(),
  ttlSeconds: v.number(),
  validationCommand: v.string(),
});

export const approve = internalMutation({
  args: {
    artifactKey: v.string(),
    artifactSha256: v.string(),
    artifactSizeBytes: v.number(),
    environment: environmentValidator,
    manifestKey: v.string(),
    manifestSha256: v.string(),
    slug: v.string(),
    sourceManifestSha256: v.string(),
    runtime: runtimeValidator,
    schemaVersion: v.number(),
  },
  handler: async (ctx, args) => {
    assertScenarioArtifactApproval(args);
    const configuredEnvironment = configuredHostedEnvironment();
    if (args.environment !== configuredEnvironment) {
      throw new Error("Artifact approval environment does not match deployment");
    }
    const lab = await ctx.db
      .query("labs")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique();
    if (!lab) throw new Error(`Scenario does not exist: ${args.slug}`);
    if (lab.status !== "active") {
      throw new Error(`Scenario is not active: ${args.slug}`);
    }

    const timestamp = Date.now();
    const activeApprovals = await ctx.db
      .query("scenarioArtifactApprovals")
      .withIndex("by_lab_environment_status", (q) =>
        q
          .eq("labId", lab._id)
          .eq("environment", args.environment)
          .eq("status", "active")
      )
      .collect();
    const plan = planScenarioArtifactApproval(activeApprovals, args);
    if (plan.unchangedId) return plan.unchangedId;

    for (const approvalId of plan.supersedeIds) {
      await ctx.db.patch(approvalId, {
        status: "superseded",
        supersededAt: timestamp,
      });
    }
    return await ctx.db.insert("scenarioArtifactApprovals", {
      ...args,
      labId: lab._id,
      status: "active",
      approvedAt: timestamp,
    });
  },
});
