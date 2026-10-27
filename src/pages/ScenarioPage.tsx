import { Link, useParams } from "react-router";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { InstructionPane } from "../components/InstructionPane";
import { WorkspacePane, useWorkspace } from "../components/WorkspacePane";
import { env } from "../lib/env";
import { formatCountdown } from "../lib/format";
import { useNow } from "../lib/useNow";
import { useScenarioSession } from "../lib/useScenarioSession";

/** Route element: a new shell per scenario, so no tab, terminal or step state leaks between scenarios. */
export function ScenarioPage() {
  const { area = "", slug = "" } = useParams();
  return <ScenarioShell key={`${area}/${slug}`} area={area} slug={slug} />;
}

function ScenarioShell({ area, slug }: { area: string; slug: string }) {
  const lab = useQuery(api.labs.getBySlug, { slug });
  const state = useScenarioSession(lab ?? null, env.defaultLearnerLabel);
  const workspace = useWorkspace();
  const now = useNow(15_000);

  if (lab === undefined || state.loading) return <p className="muted">Loading…</p>;
  if (lab === null || lab.area !== area) {
    return (
      <section className="notice">
        <h1>Unknown scenario</h1>
        <p><Link to={`/${area}`}>Back</Link></p>
      </section>
    );
  }

  const {
    phase,
    session,
    endedReason,
    agent,
    access,
    blocking,
    blockingLab,
    requestError,
    feedback,
    steps,
    currentStep,
    stepCount,
    busy,
    actionError,
    actions,
  } = state;
  const agentReady = agent?.phase === "ready";
  const setupDone = agent ? agent.setup.status === "passed" || agent.setup.status === "none" : false;
  const setupFailed = agent?.setup.status === "failed";
  const canStart = Boolean(session && access.state === "granted" && agentReady && setupDone);
  const connect = Boolean(state.usable && access.state === "granted");

  let statusText = "Initialising scenario…";
  if (phase === "blocked") statusText = "Another session is active.";
  else if (phase === "request-error") statusText = requestError ?? "Could not request a session.";
  else if (phase === "ended") statusText = endedReason ?? "This session has ended.";
  else if (phase === "idle") statusText = "No session.";
  else if (!session) statusText = "Requesting a session…";
  else if (session.status === "requested" || session.status === "starting") statusText = "Initialising scenario… (starting the environment)";
  else if (session.status === "stopping") statusText = "Stopping…";
  else if (access.state === "bootstrapping") statusText = "Connecting to the workspace…";
  else if (access.state === "failed") statusText = `Could not connect to the workspace: ${access.error ?? "unknown error"}`;
  else if (agent?.phase === "failed") statusText = `Environment failed (${agent.failure?.component ?? "unknown"}): ${agent.failure?.output ?? ""}`;
  else if (agent && agent.setup.status === "running") statusText = "Initialising scenario… (running setup)";
  else if (setupFailed) statusText = "Scenario setup failed. Check the terminal.";
  else if (agent && !agentReady) statusText = "Initialising scenario…";
  else if (agent && agent.preview.enabled && agent.preview.status !== "running") statusText = "Ready — preview starting…";
  else if (agent) statusText = "Ready.";

  const preparing = phase === "requesting" || (phase === "live" && session?.status !== "stopping");
  const startLabel = canStart
    ? "START"
    : setupFailed
      ? "SETUP FAILED"
      : agent?.phase === "failed"
        ? "UNAVAILABLE"
        : preparing
          ? "PREPARING…"
          : "START";

  const countdown = session && session.status !== "stopping" ? formatCountdown(session.expiresAt - now) : null;

  return (
    <div className="shell">
      {phase === "blocked" && blocking ? (
        <div className="banner">
          <span>
            You already have a session running
            {blockingLab ? <> in <Link to={`/${blockingLab.area}/${blockingLab.slug}`}>{blockingLab.title}</Link></> : null}. Stop it to start this scenario.
          </span>
          <button className="button button-small button-danger" disabled={busy !== null} onClick={() => void actions.stop(blocking)}>
            Stop that session
          </button>
        </div>
      ) : null}
      {phase === "request-error" ? (
        <div className="banner banner-error">
          <span>Could not start a session: {requestError}</span>
          <button className="button button-small" onClick={actions.startNew}>Try again</button>
        </div>
      ) : null}
      {phase === "ended" ? (
        <div className="banner banner-error">
          <span>{endedReason}</span>
          <button className="button button-small" onClick={actions.startNew}>Start a new session</button>
        </div>
      ) : null}
      {phase === "idle" ? (
        <div className="banner">
          <span>No session is running for this scenario.</span>
          <button className="button button-small" onClick={actions.startNew}>Start a session</button>
        </div>
      ) : null}
      {phase === "live" && access.state === "failed" ? (
        <div className="banner banner-error">
          <span>Could not connect to the workspace: {access.error ?? "unknown error"}</span>
          <button className="button button-small" onClick={actions.reconnect}>Reconnect</button>
        </div>
      ) : null}
      {phase === "live" && access.state === "granted" && access.previewError ? (
        <div className="banner banner-error">
          <span>{access.previewError}</span>
          <button className="button button-small" onClick={actions.reconnect}>Reconnect</button>
        </div>
      ) : null}
      {actionError ? (
        <div className="banner banner-error">
          <span>{actionError}</span>
          <button className="button button-small" onClick={actions.dismissError}>Dismiss</button>
        </div>
      ) : null}
      <div className="shell-panes">
        <InstructionPane
          lab={lab}
          currentStep={currentStep}
          stepCount={stepCount}
          canStart={canStart}
          startLabel={startLabel}
          busy={busy !== null}
          checking={busy === "verify"}
          navigable={phase === "live"}
          feedback={feedback}
          stepResults={steps?.results ?? []}
          onStart={() => void actions.goTo(1)}
          onBack={() => void actions.back()}
          onNext={() => void actions.next()}
          onRun={connect ? workspace.run : undefined}
          statusLine={session && canStart ? null : statusText}
        />
        <WorkspacePane
          session={session}
          tabs={lab.tabs ?? ["terminal"]}
          agent={agent}
          connect={connect}
          statusText={statusText}
          countdown={countdown}
          onStop={() => void actions.stop()}
          onConnectionLost={actions.accessLost}
          previewProblem={access.state === "granted" ? access.previewError ?? null : null}
          workspace={workspace}
        />
      </div>
    </div>
  );
}
