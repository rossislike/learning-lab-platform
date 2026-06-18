import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  labs: defineTable({
    slug: v.string(),
    title: v.string(),
    summary: v.string(),
    domainTitle: v.optional(v.string()),
    domainSummary: v.optional(v.string()),
    displayOrder: v.optional(v.number()),
    scenarioLabel: v.optional(v.string()),
    difficulty: v.number(),
    tags: v.array(v.string()),
    templatePath: v.string(),
    validationCommand: v.string(),
    previewCommand: v.string(),
    remediationFile: v.optional(v.string()),
    expectedBehavior: v.optional(v.string()),
    status: v.union(v.literal("draft"), v.literal("active"), v.literal("archived")),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_slug", ["slug"]),

  sessions: defineTable({
    labId: v.id("labs"),
    learnerLabel: v.string(),
    status: v.union(
      v.literal("requested"),
      v.literal("starting"),
      v.literal("running"),
      v.literal("checking"),
      v.literal("passed"),
      v.literal("failed"),
      v.literal("stopped"),
      v.literal("errored"),
      v.literal("expired")
    ),
    runner: v.union(v.literal("local"), v.literal("aws-ecs-fargate")),
    workspaceUrl: v.optional(v.string()),
    previewUrl: v.optional(v.string()),
    terminalUrl: v.optional(v.string()),
    editorProvider: v.optional(v.string()),
    editorContainerName: v.optional(v.string()),
    editorPort: v.optional(v.number()),
    previewPort: v.optional(v.number()),
    toolsPort: v.optional(v.number()),
    workspacePath: v.optional(v.string()),
    lastCheckSummary: v.optional(v.string()),
    lastCheckScore: v.optional(v.number()),
    ttlSeconds: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    expiresAt: v.number(),
    completedAt: v.optional(v.number()),
    stoppedAt: v.optional(v.number()),
    stopReason: v.optional(v.string()),
    cleanupRequestedAt: v.optional(v.number()),
    cleanedAt: v.optional(v.number()),
    cleanupSummary: v.optional(v.string()),
    removedFromListAt: v.optional(v.number()),
  })
    .index("by_lab", ["labId"])
    .index("by_status", ["status"])
    .index("by_expires_at", ["expiresAt"]),

  sessionEvents: defineTable({
    sessionId: v.id("sessions"),
    level: v.union(v.literal("info"), v.literal("warn"), v.literal("error")),
    message: v.string(),
    metadata: v.optional(v.any()),
    createdAt: v.number(),
  }).index("by_session", ["sessionId"]),

  progressRecords: defineTable({
    labId: v.id("labs"),
    sessionId: v.id("sessions"),
    learnerLabel: v.string(),
    status: v.union(
      v.literal("requested"),
      v.literal("starting"),
      v.literal("running"),
      v.literal("checking"),
      v.literal("passed"),
      v.literal("failed"),
      v.literal("stopped"),
      v.literal("errored"),
      v.literal("expired")
    ),
    score: v.optional(v.number()),
    summary: v.optional(v.string()),
    startedAt: v.number(),
    completedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_session", ["sessionId"])
    .index("by_lab", ["labId"])
    .index("by_lab_and_learner", ["labId", "learnerLabel"]),

  runnerHeartbeats: defineTable({
    runner: v.union(v.literal("local"), v.literal("aws-ecs-fargate")),
    runnerId: v.string(),
    pollMs: v.number(),
    pid: v.optional(v.number()),
    hostname: v.optional(v.string()),
    lastSeenAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_runner", ["runner"])
    .index("by_runner_id", ["runnerId"]),
});
