// Pure step-navigation rules, unit-tested without Convex.

export type StepDefinition = { title: string; verify?: string };
export type StepResult = { stepIndex: number; status: "pending" | "passed" | "failed" };

/**
 * Step pointer semantics: 0 = intro, 1..n = step n, n + 1 = finish.
 * Backward moves are always allowed. A forward move from step i requires
 * step i to have passed when it has a verify script.
 */
export function planStepNavigation({
  currentStep,
  requestedStep,
  steps,
  results,
}: {
  currentStep: number;
  requestedStep: number;
  steps: StepDefinition[];
  results: StepResult[];
}): { allowed: true; step: number } | { allowed: false; reason: string } {
  const last = steps.length + 1;
  if (!Number.isInteger(requestedStep) || requestedStep < 0 || requestedStep > last) {
    return { allowed: false, reason: `Step must be between 0 and ${last}` };
  }
  if (requestedStep <= currentStep) return { allowed: true, step: requestedStep };
  if (requestedStep > currentStep + 1) {
    return { allowed: false, reason: "Steps must be completed in order" };
  }
  if (currentStep >= 1 && currentStep <= steps.length) {
    const step = steps[currentStep - 1];
    if (step.verify) {
      const result = results.find((row) => row.stepIndex === currentStep);
      if (result?.status !== "passed") {
        return { allowed: false, reason: `Step ${currentStep} has not been verified yet` };
      }
    }
  }
  return { allowed: true, step: requestedStep };
}

/**
 * Progress for the dashboard and progress records.
 *
 * A step counts as completed when it has a verify script and has passed, or
 * when it has no verify script and the learner has moved past it
 * (`currentStep > its 1-based index`). `totalSteps` is every step, so the
 * denominator matches the step dots in the shell.
 *
 * The scenario is complete when every step is completed and the finish page
 * is showing (`currentStep === steps.length + 1`). A zero-step playground is
 * complete as soon as START has been pressed (`currentStep >= 1`).
 */
export function summarizeStepProgress(
  steps: StepDefinition[],
  results: StepResult[],
  currentStep: number
) {
  const passed = new Set(
    results.filter((row) => row.status === "passed").map((row) => row.stepIndex)
  );
  let completedSteps = 0;
  let verifiableSteps = 0;
  steps.forEach((step, index) => {
    const stepIndex = index + 1;
    if (step.verify) {
      verifiableSteps += 1;
      if (passed.has(stepIndex)) completedSteps += 1;
    } else if (currentStep > stepIndex) {
      completedSteps += 1;
    }
  });
  const complete =
    steps.length === 0
      ? currentStep >= 1
      : completedSteps === steps.length && currentStep === steps.length + 1;
  return {
    completedSteps,
    totalSteps: steps.length,
    verifiableSteps,
    complete,
  };
}
