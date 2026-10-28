import { stripAnsi } from "../lib/text";
import { Markdown } from "./Markdown";
import type { Lab, StepFeedback } from "../lib/useScenarioSession";

type Props = {
  lab: Lab;
  currentStep: number;
  stepCount: number;
  canStart: boolean;
  /** START button label while it cannot be pressed (PREPARING…, SETUP FAILED, …). */
  startLabel: string;
  busy: boolean;
  /** A verify is running (NEXT reads CHECKING…). */
  checking: boolean;
  /** The step pointer can move (there is a live session). */
  navigable: boolean;
  feedback: StepFeedback;
  stepResults: { stepIndex: number; status: string }[];
  onStart: () => void;
  onBack: () => void;
  onNext: () => void;
  onRun?: (command: string) => void;
  statusLine?: string | null;
};

export function InstructionPane({
  lab,
  currentStep,
  stepCount,
  canStart,
  startLabel,
  busy,
  checking,
  navigable,
  feedback,
  stepResults,
  onStart,
  onBack,
  onNext,
  onRun,
  statusLine,
}: Props) {
  const onIntro = currentStep === 0;
  const onFinish = currentStep > stepCount;
  const step = !onIntro && !onFinish ? lab.steps?.[currentStep - 1] : undefined;
  const content = onIntro ? lab.intro ?? "" : onFinish ? lab.finish ?? "" : step?.content ?? "";
  const passed = new Set(stepResults.filter((row) => row.status === "passed").map((row) => row.stepIndex));

  return (
    <aside className="instructions">
      <div className="instructions-scroll">
        <header className="instructions-header">
          <h1 className="scenario-title">{lab.title}</h1>
          {step ? <p className="step-subtitle">{step.title}</p> : null}
        </header>
        {stepCount > 0 ? (
          <div className="step-dots" aria-label={`Step ${Math.min(Math.max(currentStep, 0), stepCount)} of ${stepCount}`}>
            <span className="step-rule" />
            <span className="step-dot-row">
              {Array.from({ length: stepCount }, (_, index) => {
                const number = index + 1;
                const className = [
                  "step-dot",
                  number === currentStep ? "is-current" : "",
                  passed.has(number) || number < currentStep ? "is-done" : "",
                ].join(" ");
                return <span key={number} className={className} title={lab.steps?.[index]?.title} />;
              })}
            </span>
            <span className="step-rule" />
          </div>
        ) : null}
        {onIntro && !lab.intro ? <p className="muted">{lab.summary}</p> : null}
        <Markdown content={content} onRun={onRun} />
        {feedback && feedback.stepIndex === currentStep ? (
          <div className={`verify ${feedback.result.passed ? "verify-pass" : "verify-fail"}`}>
            <strong>{feedback.result.passed ? "Check passed" : "Not yet"}</strong>
            {feedback.note ? <p>{feedback.note}</p> : null}
            {feedback.result.output ? <pre>{stripAnsi(feedback.result.output)}</pre> : null}
          </div>
        ) : null}
      </div>
      <footer className="instructions-footer">
        <span className="muted small">{statusLine ?? ""}</span>
        <div className="instructions-buttons">
          {onIntro ? (
            <button className="button button-primary" onClick={onStart} disabled={!canStart || busy}>
              {startLabel}
            </button>
          ) : (
            <>
              <button className="button" onClick={onBack} disabled={busy || !navigable}>
                BACK
              </button>
              {!onFinish ? (
                <button className="button button-primary" onClick={onNext} disabled={busy || !canStart}>
                  {checking ? "CHECKING…" : currentStep === stepCount ? "FINISH" : "NEXT"}
                </button>
              ) : null}
            </>
          )}
        </div>
      </footer>
    </aside>
  );
}
