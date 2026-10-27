// Everything the scenario shell needs about one learner's session for a
// scenario: request it, follow it to `running`, bootstrap the gateway
// cookies, follow the agent's readiness, move the step pointer, verify.
//
// Which session the page shows, and whether it should request one, is the
// pure `deriveSessionView` (sessionState.ts): the newest session for this
// scenario whatever its status, a request at most once per page open (and
// only when the learner has no session for this scenario at all), explicit
// "Start a new session" after a stop, error or expiry.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { deriveSessionView, errorMessage, type RequestError } from "./sessionState";
import {
  bootstrapEndpoint,
  fetchReady,
  isAccessDenied,
  logoutEndpoint,
  openStep as openStepOnAgent,
  probeEndpoint,
  verifyStep as verifyStepOnAgent,
  type AgentSummary,
  type VerifyResult,
} from "./gateway";

export type Lab = Doc<"labs">;
export type Session = Doc<"sessions">;

export type AccessState = "none" | "bootstrapping" | "granted" | "failed";

export type StepFeedback = { stepIndex: number; result: VerifyResult; note?: string } | null;

export type BusyAction = "verify" | "move" | "stop" | null;

type Access = {
  sessionId: Id<"sessions"> | null;
  state: AccessState;
  error?: string;
  /** The workspace is reachable but the preview host could not be authorized. */
  previewError?: string;
};

const LOST_ACCESS = "Lost access to the workspace; reconnecting. Try again in a moment.";

function requireCode(code: string | undefined, scope: string) {
  if (!code) throw new Error(`no ${scope} bootstrap code was issued`);
  return code;
}

function isSettled(summary: AgentSummary | null) {
  return (
    summary?.phase === "failed" ||
    (summary?.phase === "ready" &&
      (summary.setup.status === "passed" || summary.setup.status === "none") &&
      (!summary.preview.enabled || summary.preview.status === "running"))
  );
}

export function useScenarioSession(lab: Lab | null | undefined, learnerLabel: string) {
  const sessions = useQuery(api.sessions.list);
  const requestSession = useMutation(api.sessions.request);
  const stopSession = useMutation(api.sessions.stop);
  const issueBootstrap = useMutation(api.workspaceAccess.issueBootstrap);
  const setCurrentStep = useMutation(api.steps.setCurrentStep);

  // --- 1. Which session, and requesting one -------------------------------
  const [requested, setRequested] = useState(false);
  const [inFlight, setInFlight] = useState(false);
  const [pendingId, setPendingId] = useState<Id<"sessions"> | null>(null);
  const [requestError, setRequestError] = useState<RequestError | null>(null);
  // Synchronous once-per-open guard (StrictMode runs effects twice).
  const requestGuard = useRef(false);

  const labId = lab?._id ?? null;
  const view = useMemo(
    () => deriveSessionView({ sessions, labId, requested, inFlight, pendingId, requestError }),
    [sessions, labId, requested, inFlight, pendingId, requestError]
  );
  const latestIdRef = useRef<Id<"sessions"> | null>(null);
  const liveIdRef = useRef<Id<"sessions"> | null>(null);
  const live = view.live;
  const liveId = live?._id ?? null;
  useEffect(() => {
    latestIdRef.current = view.latest?._id ?? null;
    liveIdRef.current = liveId;
  }, [view.latest, liveId]);

  const startRequest = useCallback(async () => {
    if (!lab) return;
    requestGuard.current = true;
    setRequested(true);
    setInFlight(true);
    setRequestError(null);
    setPendingId(null);
    try {
      setPendingId(await requestSession({ labId: lab._id, learnerLabel }));
    } catch (error) {
      setRequestError({ message: errorMessage(error), latestId: latestIdRef.current });
    } finally {
      setInFlight(false);
    }
  }, [lab, learnerLabel, requestSession]);

  useEffect(() => {
    if (!view.shouldRequest || requestGuard.current) return;
    void startRequest();
  }, [view.shouldRequest, startRequest]);

  const blockingLab = useQuery(api.labs.get, view.blocking ? { labId: view.blocking.labId } : "skip");
  const latestId = view.latest?._id ?? null;
  const steps = useQuery(api.steps.listForSession, latestId ? { sessionId: latestId } : "skip");

  // --- 2. Gateway access for the live session -----------------------------
  // Probe the workspace (/ready) and preview hosts; on 401/403 issue codes
  // and bootstrap each host that needs it. The in-flight guard is a ref and
  // results are dropped only when the live session changed, so a dependency
  // change mid-flight cannot leave the state stuck.
  const workspaceUrl = view.usable ? live?.workspaceUrl ?? null : null;
  const previewUrl = view.usable ? live?.previewUrl ?? null : null;
  const [access, setAccess] = useState<Access>({ sessionId: null, state: "none" });
  const bootstrapFor = useRef<Id<"sessions"> | null>(null);
  useEffect(() => {
    if (!liveId || !workspaceUrl) return;
    if (access.sessionId === liveId && access.state !== "none") return;
    if (bootstrapFor.current === liveId) return;
    bootstrapFor.current = liveId;
    const sessionId = liveId;
    const settle = (next: Omit<Access, "sessionId">) => {
      if (liveIdRef.current === null || liveIdRef.current === sessionId) setAccess({ sessionId, ...next });
    };
    void (async () => {
      try {
        const [workspaceDenied, previewDenied] = await Promise.all([
          fetchReady(workspaceUrl).then(
            () => false,
            (error: unknown) => {
              if (isAccessDenied(error)) return true;
              throw error;
            }
          ),
          previewUrl ? probeEndpoint(previewUrl).then((probe) => probe.denied, () => false) : false,
        ]);
        if (!workspaceDenied && !previewDenied) return settle({ state: "granted" });
        const bundle = await issueBootstrap({ sessionId });
        const [workspace, preview] = await Promise.allSettled([
          workspaceDenied ? bootstrapEndpoint(workspaceUrl, requireCode(bundle.codes.workspace, "workspace")) : null,
          previewDenied && previewUrl ? bootstrapEndpoint(previewUrl, requireCode(bundle.codes.preview, "preview")) : null,
        ]);
        if (workspace.status === "rejected") return settle({ state: "failed", error: errorMessage(workspace.reason) });
        settle({
          state: "granted",
          previewError:
            preview.status === "rejected" ? `Could not authorize the preview: ${errorMessage(preview.reason)}` : undefined,
        });
      } catch (error) {
        settle({ state: "failed", error: errorMessage(error) });
      } finally {
        if (bootstrapFor.current === sessionId) bootstrapFor.current = null;
      }
    })();
  }, [liveId, workspaceUrl, previewUrl, access.sessionId, access.state, issueBootstrap]);

  const granted = Boolean(liveId && workspaceUrl && access.sessionId === liveId && access.state === "granted");

  /** Access was refused somewhere (verify 401, terminal gave up): probe and bootstrap again. */
  const accessLost = useCallback(() => {
    const id = liveIdRef.current;
    if (!id) return;
    setAccess((previous) =>
      previous.sessionId === id && previous.state === "granted" ? { sessionId: id, state: "none" } : previous
    );
  }, []);

  /** "Reconnect" after a failed bootstrap or an unauthorized preview. */
  const reconnect = useCallback(() => {
    const id = liveIdRef.current;
    if (id) setAccess({ sessionId: id, state: "none" });
  }, []);

  // --- 3. Agent readiness --------------------------------------------------
  // Fast polling until setup and preview settle, then a slow heartbeat that
  // notices a crashed preview or a revoked cookie.
  const [agentState, setAgent] = useState<{ sessionId: Id<"sessions">; summary: AgentSummary } | null>(null);
  useEffect(() => {
    if (!liveId || !workspaceUrl || !granted) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const { summary } = await fetchReady(workspaceUrl);
        if (stopped) return;
        if (summary) setAgent({ sessionId: liveId, summary });
        timer = setTimeout(poll, isSettled(summary) ? 15_000 : 2_000);
      } catch (error) {
        if (stopped) return;
        if (isAccessDenied(error)) {
          setAccess({ sessionId: liveId, state: "none" });
          return;
        }
        timer = setTimeout(poll, 3_000);
      }
    };
    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [liveId, workspaceUrl, granted]);

  const agent = granted && agentState?.sessionId === liveId ? agentState.summary : null;

  // --- 4. Steps, verify, stop ---------------------------------------------
  const currentStep = steps?.currentStep ?? view.latest?.currentStep ?? 0;
  const stepCount = lab?.steps?.length ?? 0;
  const [feedbackState, setFeedback] = useState<(StepFeedback & { sessionId: Id<"sessions"> }) | null>(null);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const goTo = useCallback(
    async (step: number) => {
      if (!live) return;
      setBusy("move");
      setActionError(null);
      try {
        await setCurrentStep({ sessionId: live._id, step });
        setFeedback(null);
        if (step >= 1 && step <= stepCount && lab?.steps?.[step - 1]?.setup && workspaceUrl) {
          openStepOnAgent(workspaceUrl, step).catch((error: unknown) => {
            if (isAccessDenied(error)) accessLost();
            setActionError(`Step ${step} setup: ${isAccessDenied(error) ? LOST_ACCESS : errorMessage(error)}`);
          });
        }
      } catch (error) {
        setActionError(errorMessage(error));
      } finally {
        setBusy(null);
      }
    },
    [live, lab, setCurrentStep, stepCount, workspaceUrl, accessLost]
  );

  const next = useCallback(async () => {
    if (!live || !lab) return;
    const step = lab.steps?.[currentStep - 1];
    if (currentStep >= 1 && currentStep <= stepCount && step?.verify) {
      if (!workspaceUrl) return;
      const sessionId = live._id;
      setBusy("verify");
      setActionError(null);
      let result: VerifyResult;
      try {
        result = await verifyStepOnAgent(workspaceUrl, currentStep);
      } catch (error) {
        if (isAccessDenied(error)) accessLost();
        setFeedback({
          sessionId,
          stepIndex: currentStep,
          result: { passed: false, output: isAccessDenied(error) ? LOST_ACCESS : errorMessage(error) },
        });
        return;
      } finally {
        setBusy(null);
      }
      if (result.passed && result.reported === false) {
        setFeedback({
          sessionId,
          stepIndex: currentStep,
          result,
          note: "The check passed, but the result could not be recorded, so the step cannot advance yet. Press NEXT to check again.",
        });
        return;
      }
      setFeedback({ sessionId, stepIndex: currentStep, result });
      if (!result.passed) return;
    }
    await goTo(Math.min(currentStep + 1, stepCount + 1));
  }, [live, lab, currentStep, stepCount, workspaceUrl, goTo, accessLost]);

  const back = useCallback(() => goTo(Math.max(currentStep - 1, 0)), [goTo, currentStep]);

  const stop = useCallback(
    async (session: Session | null = live) => {
      if (!session) return;
      setBusy("stop");
      setActionError(null);
      try {
        await stopSession({ sessionId: session._id, reason: "Stopped by the learner" });
        // The grants are revoked by the stop; clearing the cookies is tidy-up.
        if (session.workspaceUrl) void logoutEndpoint(session.workspaceUrl);
        if (session.previewUrl) void logoutEndpoint(session.previewUrl);
      } catch (error) {
        setActionError(`Could not stop the session: ${errorMessage(error)}`);
      } finally {
        setBusy(null);
      }
    },
    [live, stopSession]
  );

  const startNew = useCallback(() => void startRequest(), [startRequest]);
  const dismissError = useCallback(() => setActionError(null), []);

  const accessView: { state: AccessState; error?: string; previewError?: string } =
    liveId && access.sessionId === liveId && access.state !== "none"
      ? access
      : { state: workspaceUrl ? "bootstrapping" : "none" };

  const feedback: StepFeedback =
    feedbackState && feedbackState.sessionId === liveId
      ? { stepIndex: feedbackState.stepIndex, result: feedbackState.result, note: feedbackState.note }
      : null;

  return {
    loading: view.phase === "loading",
    phase: view.phase,
    /** The live (active) session for this scenario, if any. */
    session: live,
    endedSession: view.ended,
    endedReason: view.endedReason,
    blocking: view.blocking,
    blockingLab: blockingLab ?? null,
    requestError: view.requestError,
    access: accessView,
    agent,
    steps,
    currentStep,
    stepCount,
    feedback,
    busy,
    actionError,
    usable: view.usable,
    actions: { goTo, next, back, stop, startNew, reconnect, accessLost, dismissError },
  };
}
