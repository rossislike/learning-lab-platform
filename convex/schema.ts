import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const scenarioKind = v.union(v.literal("terminal"), v.literal("react"));
export const workspaceTab = v.union(
  v.literal("terminal"),
  v.literal("editor"),
  v.literal("preview")
);
export const scenarioWorkspace = v.object({
  cwd: v.string(),
  user: v.union(v.literal("learner"), v.literal("root")),
});
export const scenarioReact = v.object({
  previewPort: v.number(),
  installCommand: v.string(),
  devCommand: v.string(),
  testCommand: v.string(),
});
export const scenarioStep = v.object({
  title: v.string(),
  content: v.string(),
  setup: v.optional(v.string()),
  verify: v.optional(v.string()),
});

// What a session pod needs to know about its scenario (manifest v2).
const scenarioRuntimeContract = v.object({
  kind: scenarioKind,
  ttlSeconds: v.number(),
  workspace: scenarioWorkspace,
  tabs: v.array(workspaceTab),
  setup: v.optional(v.string()),
  stepCount: v.number(),
  react: v.optional(scenarioReact),
});

export default defineSchema({
  users: defineTable({
    clerkSubject: v.string(),
    tokenIdentifier: v.string(),
    displayName: v.string(),
    email: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    lastSeenAt: v.number(),
  })
    .index("by_clerk_subject", ["clerkSubject"])
    .index("by_token_identifier", ["tokenIdentifier"]),

  courses: defineTable({
    slug: v.string(),
    title: v.string(),
    summary: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_slug", ["slug"]),

  courseModules: defineTable({
    courseId: v.id("courses"),
    slug: v.string(),
    title: v.string(),
    summary: v.string(),
    displayOrder: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_course", ["courseId"])
    .index("by_slug", ["slug"]),

  areas: defineTable({
    slug: v.string(),
    title: v.string(),
    summary: v.string(),
    displayOrder: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_slug", ["slug"]),

  // Scenarios. The table keeps its historical name until the Phase 4 frontend
  // rewrite; manifest v2 fields are below, legacy v1 fields are optional.
  labs: defineTable({
    courseId: v.optional(v.id("courses")),
    moduleId: v.optional(v.id("courseModules")),
    slug: v.string(),
    title: v.string(),
    summary: v.string(),
    status: v.union(v.literal("draft"), v.literal("active"), v.literal("archived")),
    difficulty: v.number(),
    tags: v.array(v.string()),
    displayOrder: v.optional(v.number()),
    // manifest v2
    manifestVersion: v.optional(v.number()),
    area: v.optional(v.string()),
    kind: v.optional(scenarioKind),
    difficultyLabel: v.optional(v.string()),
    ttlSeconds: v.optional(v.number()),
    tabs: v.optional(v.array(workspaceTab)),
    workspace: v.optional(scenarioWorkspace),
    setup: v.optional(v.string()),
    intro: v.optional(v.string()),
    finish: v.optional(v.string()),
    steps: v.optional(v.array(scenarioStep)),
    react: v.optional(scenarioReact),
    // dashboard grouping compatibility (removed in Phase 4)
    domainTitle: v.optional(v.string()),
    domainSummary: v.optional(v.string()),
    scenarioLabel: v.optional(v.string()),
    // legacy local Docker runner inputs (react only; removed in Phase 3)
    templatePath: v.optional(v.string()),
    validationCommand: v.optional(v.string()),
    previewCommand: v.optional(v.string()),
    // legacy, unused after Phase 4 (still read by App.tsx's session panel)
    remediationFile: v.optional(v.string()),
    expectedBehavior: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_slug", ["slug"])
    .index("by_area", ["area"]),

  scenarioArtifactApprovals: defineTable({
    labId: v.id("labs"),
    slug: v.string(),
    environment: v.literal("dev"),
    artifactSha256: v.string(),
    artifactKey: v.string(),
    artifactSizeBytes: v.number(),
    manifestSha256: v.string(),
    manifestKey: v.string(),
    sourceManifestSha256: v.string(),
    runtime: scenarioRuntimeContract,
    schemaVersion: v.number(),
    status: v.union(v.literal("active"), v.literal("superseded")),
    approvedAt: v.number(),
    supersededAt: v.optional(v.number()),
  })
    .index("by_lab_environment_status", ["labId", "environment", "status"])
    .index("by_slug_environment", ["slug", "environment"]),

  sessions: defineTable({
    labId: v.id("labs"),
    learnerLabel: v.string(),
    ownerSubject: v.optional(v.string()),
    sessionOwnerKey: v.optional(v.string()),
    status: v.union(
      v.literal("requested"),
      v.literal("starting"),
      v.literal("running"),
      v.literal("checking"),
      v.literal("passed"),
      v.literal("failed"),
      v.literal("stopping"),
      v.literal("stopped"),
      v.literal("errored"),
      v.literal("expired")
    ),
    runner: v.union(v.literal("local"), v.literal("kubernetes")),
    workspaceUrl: v.optional(v.string()),
    previewUrl: v.optional(v.string()),
    terminalUrl: v.optional(v.string()),
    editorProvider: v.optional(v.string()),
    editorContainerName: v.optional(v.string()),
    editorPort: v.optional(v.number()),
    previewPort: v.optional(v.number()),
    toolsPort: v.optional(v.number()),
    workspacePath: v.optional(v.string()),
    runnerResourceId: v.optional(v.string()),
    hostedScenario: v.optional(
      v.object({
        approvalId: v.id("scenarioArtifactApprovals"),
        environment: v.literal("dev"),
        slug: v.string(),
        artifactSha256: v.string(),
        artifactKey: v.string(),
        artifactSizeBytes: v.number(),
        manifestSha256: v.string(),
        manifestKey: v.string(),
        sourceManifestSha256: v.string(),
        runtime: scenarioRuntimeContract,
        schemaVersion: v.number(),
      })
    ),
    lastCheckSummary: v.optional(v.string()),
    lastCheckScore: v.optional(v.number()),
    // 0 = intro shown, 1..n = step n shown, n+1 = finish shown
    currentStep: v.optional(v.number()),
    ttlSeconds: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    expiresAt: v.number(),
    startedAt: v.optional(v.number()),
    startupDurationMs: v.optional(v.number()),
    lastCheckStartedAt: v.optional(v.number()),
    lastCheckCompletedAt: v.optional(v.number()),
    lastValidationDurationMs: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    stoppedAt: v.optional(v.number()),
    stopReason: v.optional(v.string()),
    cleanupRequestedAt: v.optional(v.number()),
    cleanedAt: v.optional(v.number()),
    cleanupDurationMs: v.optional(v.number()),
    cleanupSummary: v.optional(v.string()),
    removedFromListAt: v.optional(v.number()),
  })
    .index("by_lab", ["labId"])
    .index("by_session_owner", ["sessionOwnerKey"])
    .index("by_status", ["status"])
    .index("by_expires_at", ["expiresAt"]),

  sessionSteps: defineTable({
    sessionId: v.id("sessions"),
    stepIndex: v.number(),
    status: v.union(v.literal("pending"), v.literal("passed"), v.literal("failed")),
    output: v.optional(v.string()),
    attempts: v.number(),
    verifiedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_session", ["sessionId"])
    .index("by_session_step", ["sessionId", "stepIndex"]),

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
    ownerSubject: v.optional(v.string()),
    sessionOwnerKey: v.optional(v.string()),
    status: v.union(
      v.literal("requested"),
      v.literal("starting"),
      v.literal("running"),
      v.literal("checking"),
      v.literal("passed"),
      v.literal("failed"),
      v.literal("stopping"),
      v.literal("stopped"),
      v.literal("errored"),
      v.literal("expired")
    ),
    score: v.optional(v.number()),
    summary: v.optional(v.string()),
    completedSteps: v.optional(v.number()),
    totalSteps: v.optional(v.number()),
    startedAt: v.number(),
    completedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_session", ["sessionId"])
    .index("by_lab", ["labId"])
    .index("by_session_owner", ["sessionOwnerKey"])
    .index("by_lab_and_learner", ["labId", "learnerLabel"]),

  runnerHeartbeats: defineTable({
    runner: v.union(v.literal("local"), v.literal("kubernetes")),
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
