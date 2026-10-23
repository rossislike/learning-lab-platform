import assert from "node:assert/strict"
import test from "node:test"
import { planStepNavigation, summarizeStepProgress } from "./stepPolicy.ts"

const steps = [
  { title: "Look around" },
  { title: "Do the thing", verify: "scripts/step2-verify.sh" },
  { title: "Finish up", verify: "scripts/step3-verify.sh" },
]

test("START moves from intro to step 1", () => {
  assert.deepEqual(
    planStepNavigation({ currentStep: 0, requestedStep: 1, steps, results: [] }),
    { allowed: true, step: 1 },
  )
})

test("NEXT past an unverified step without a verify script is allowed", () => {
  assert.deepEqual(
    planStepNavigation({ currentStep: 1, requestedStep: 2, steps, results: [] }),
    { allowed: true, step: 2 },
  )
})

test("NEXT past a verifiable step requires a pass", () => {
  assert.equal(
    planStepNavigation({ currentStep: 2, requestedStep: 3, steps, results: [] }).allowed,
    false,
  )
  assert.equal(
    planStepNavigation({
      currentStep: 2,
      requestedStep: 3,
      steps,
      results: [{ stepIndex: 2, status: "failed" }],
    }).allowed,
    false,
  )
  assert.deepEqual(
    planStepNavigation({
      currentStep: 2,
      requestedStep: 3,
      steps,
      results: [{ stepIndex: 2, status: "passed" }],
    }),
    { allowed: true, step: 3 },
  )
})

test("BACK and jumping backwards are always allowed; skipping ahead is not", () => {
  assert.deepEqual(
    planStepNavigation({ currentStep: 3, requestedStep: 1, steps, results: [] }),
    { allowed: true, step: 1 },
  )
  assert.equal(
    planStepNavigation({ currentStep: 1, requestedStep: 3, steps, results: [] }).allowed,
    false,
  )
  assert.equal(
    planStepNavigation({ currentStep: 1, requestedStep: 9, steps, results: [] }).allowed,
    false,
  )
})

test("finish page is step n + 1 and a playground goes straight there", () => {
  assert.deepEqual(
    planStepNavigation({
      currentStep: 3,
      requestedStep: 4,
      steps,
      results: [{ stepIndex: 3, status: "passed" }],
    }),
    { allowed: true, step: 4 },
  )
  assert.deepEqual(
    planStepNavigation({ currentStep: 0, requestedStep: 1, steps: [], results: [] }),
    { allowed: true, step: 1 },
  )
})

test("progress counts passed verifiable steps and no-verify steps the learner moved past", () => {
  assert.deepEqual(summarizeStepProgress(steps, [], 0), {
    completedSteps: 0,
    totalSteps: 3,
    verifiableSteps: 2,
    complete: false,
  })
  // on step 1 (no verify): not yet past it
  assert.equal(summarizeStepProgress(steps, [], 1).completedSteps, 0)
  // moved to step 2: step 1 counts
  assert.equal(summarizeStepProgress(steps, [], 2).completedSteps, 1)
  // verifiable steps need a pass regardless of the pointer
  assert.equal(summarizeStepProgress(steps, [], 4).completedSteps, 1)
  assert.equal(
    summarizeStepProgress(steps, [{ stepIndex: 2, status: "failed" }], 3).completedSteps,
    1,
  )
})

test("complete requires every step done and the finish page showing", () => {
  const allPassed = [
    { stepIndex: 2, status: "passed" },
    { stepIndex: 3, status: "passed" },
  ]
  assert.deepEqual(summarizeStepProgress(steps, allPassed, 3), {
    completedSteps: 3,
    totalSteps: 3,
    verifiableSteps: 2,
    complete: false,
  })
  assert.deepEqual(summarizeStepProgress(steps, allPassed, 4), {
    completedSteps: 3,
    totalSteps: 3,
    verifiableSteps: 2,
    complete: true,
  })
  // a pointer beyond the finish page never happens through planStepNavigation,
  // but the summary must not report completion for it either
  assert.equal(summarizeStepProgress(steps, allPassed, 5).complete, false)
})

test("a playground completes on START", () => {
  assert.deepEqual(summarizeStepProgress([], [], 0), {
    completedSteps: 0,
    totalSteps: 0,
    verifiableSteps: 0,
    complete: false,
  })
  assert.equal(summarizeStepProgress([], [], 1).complete, true)
})

test("navigation rejects a pointer past the finish page", () => {
  assert.equal(
    planStepNavigation({ currentStep: 4, requestedStep: 5, steps, results: [] }).allowed,
    false,
  )
  assert.deepEqual(
    planStepNavigation({ currentStep: 4, requestedStep: 4, steps, results: [] }),
    { allowed: true, step: 4 },
  )
  assert.equal(
    planStepNavigation({ currentStep: 0, requestedStep: 2, steps: [], results: [] }).allowed,
    false,
  )
})
