import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { requireSessionAgent, requireSessionOwner } from "./access";
import { isActiveSessionStatus } from "./sessionLifecycle";
import { planStepNavigation, summarizeStepProgress } from "./stepPolicy";
import type { Doc } from "./_generated/dataModel";

const now = () => Date.now();

async function loadSteps(ctx: QueryCtx | MutationCtx, sessionId: Id<"sessions">) {
  return await ctx.db
    .query("sessionSteps")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .collect();
}

function requireActiveSession(session: Doc<"sessions">) {
  if (!isActiveSessionStatus(session.status)) {
    throw new Error(`Session is ${session.status}; steps can no longer change`);
  }
}

/**
 * Recomputes completedSteps/totalSteps on the session's progress record from
 * the step pointer and verify results, and stamps completedAt the first time
 * the scenario completes. Shared by pointer moves and verify results so
 * no-verify steps and playgrounds get credit too.
 */
async function syncProgress(
  ctx: MutationCtx,
  session: Doc<"sessions">,
  steps: { title: string; verify?: string }[],
  currentStep: number,
  timestamp: number
) {
  const results = await loadSteps(ctx, session._id);
  const progress = summarizeStepProgress(steps, results, currentStep);
  const [record] = await ctx.db
    .query("progressRecords")
    .withIndex("by_session", (q) => q.eq("sessionId", session._id))
    .take(1);
  if (record) {
    await ctx.db.patch(record._id, {
      completedSteps: progress.completedSteps,
      totalSteps: progress.totalSteps,
      ...(progress.complete && !record.completedAt ? { completedAt: timestamp } : {}),
      updatedAt: timestamp,
    });
  }
  return progress;
}

/** Current step pointer plus per-step results, for the scenario shell. */
export const listForSession = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const session = await requireSessionOwner(ctx, await ctx.db.get(args.sessionId));
    const lab = await ctx.db.get(session.labId);
    const results = await loadSteps(ctx, args.sessionId);
    return {
      currentStep: session.currentStep ?? 0,
      totalSteps: lab?.steps?.length ?? 0,
      results: results
        .sort((a, b) => a.stepIndex - b.stepIndex)
        .map((row) => ({
          stepIndex: row.stepIndex,
          status: row.status,
          output: row.output,
          attempts: row.attempts,
          verifiedAt: row.verifiedAt,
        })),
    };
  },
});

/**
 * Moves the learner's step pointer (START, BACK, NEXT). Moving forward past a
 * step that has a verify script requires that step to have passed.
 */
export const setCurrentStep = mutation({
  args: { sessionId: v.id("sessions"), step: v.number() },
  handler: async (ctx, args) => {
    const session = await requireSessionOwner(ctx, await ctx.db.get(args.sessionId));
    requireActiveSession(session);
    const lab = await ctx.db.get(session.labId);
    if (!lab) throw new Error("Scenario not found");
    const steps = lab.steps ?? [];
    const results = await loadSteps(ctx, args.sessionId);
    const plan = planStepNavigation({
      currentStep: session.currentStep ?? 0,
      requestedStep: args.step,
      steps,
      results,
    });
    if (!plan.allowed) throw new Error(plan.reason);
    const timestamp = now();
    await ctx.db.patch(args.sessionId, { currentStep: plan.step, updatedAt: timestamp });
    await syncProgress(ctx, session, steps, plan.step, timestamp);
    return plan.step;
  },
});

/**
 * Recorded by the session agent after running a step's verify script.
 * Authorized by the session-bound agent token (normal path) or the runner
 * secret (dispatcher / legacy runner).
 */
/**
 * Called by the session agent with its session-bound token (ADR 0005). A
 * missing session and a bad token produce the same error so the response does
 * not reveal whether a session id exists.
 */
export const recordStepResult = mutation({
  args: {
    sessionToken: v.string(),
    sessionId: v.id("sessions"),
    stepIndex: v.number(),
    passed: v.boolean(),
    output: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error("Session agent authorization failed");
    requireSessionAgent(session, args.sessionToken);
    requireActiveSession(session);
    const lab = await ctx.db.get(session.labId);
    const steps = lab?.steps ?? [];
    if (!Number.isInteger(args.stepIndex) || args.stepIndex < 1 || args.stepIndex > steps.length) {
      throw new Error(`stepIndex must be between 1 and ${steps.length}`);
    }
    const timestamp = now();
    const output = args.output?.slice(0, 16_000);
    const existing = await ctx.db
      .query("sessionSteps")
      .withIndex("by_session_step", (q) =>
        q.eq("sessionId", args.sessionId).eq("stepIndex", args.stepIndex)
      )
      .unique();
    const status = args.passed ? "passed" : "failed";
    if (existing) {
      await ctx.db.patch(existing._id, {
        status,
        output,
        attempts: existing.attempts + 1,
        ...(args.passed ? { verifiedAt: timestamp } : {}),
        updatedAt: timestamp,
      });
    } else {
      await ctx.db.insert("sessionSteps", {
        sessionId: args.sessionId,
        stepIndex: args.stepIndex,
        status,
        output,
        attempts: 1,
        ...(args.passed ? { verifiedAt: timestamp } : {}),
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }
    await ctx.db.insert("sessionEvents", {
      sessionId: args.sessionId,
      level: args.passed ? "info" : "warn",
      message: `Step ${args.stepIndex} ${status}`,
      createdAt: timestamp,
    });

    return await syncProgress(ctx, session, steps, session.currentStep ?? 0, timestamp);
  },
});
