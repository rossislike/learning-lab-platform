// Pure session-shell state: which session the scenario page is showing and
// whether it should request one. Kept free of React and Convex imports so it
// runs under `node --test` (src/lib/sessionState.test.mjs).

/** Mirrors convex/sessions.ts: statuses that hold a slot for the learner. */
export const ACTIVE_STATUSES: ReadonlySet<string> = new Set([
  "requested",
  "starting",
  "running",
  "checking",
  "passed",
  "failed",
  "stopping",
]);
/** Statuses in which the pod is up and its endpoints can be used. */
export const USABLE_STATUSES: ReadonlySet<string> = new Set(["running", "checking", "passed", "failed"]);
/** Terminal statuses: the session is gone and a new one has to be requested. */
export const ENDED_STATUSES: ReadonlySet<string> = new Set(["stopped", "errored", "expired"]);

export type SessionLike = {
  _id: string;
  labId: string;
  status: string;
  workspaceUrl?: string;
  stopReason?: string;
  lastCheckSummary?: string;
};

export type SessionPhase =
  | "loading" // sessions or the scenario not loaded yet
  | "requesting" // a request is (about to be) in flight, or its session has not appeared yet
  | "request-error" // the last request failed
  | "blocked" // another scenario's session is active
  | "live" // the latest session for this scenario is active
  | "ended" // the latest session for this scenario is stopped/errored/expired
  | "idle"; // nothing for this scenario and nothing in flight (offer to start)

export type SessionInput<S extends SessionLike> = {
  /** `sessions.list` result (newest first), undefined while loading. */
  sessions: readonly S[] | undefined;
  labId: string | null;
  /** The page already requested a session during this open (once-per-open guard). */
  requested: boolean;
  /** A `sessions.request` call is in flight. */
  inFlight: boolean;
  /** Id returned by the last successful request, until it shows up in `sessions`. */
  pendingId: string | null;
  /**
   * The last failed request, with the id of the newest session for this
   * scenario at the time it failed. It stops applying once a newer session
   * shows up (so an old error never outranks a live or later-ended session).
   */
  requestError: RequestError | null;
};

export type RequestError = { message: string; latestId: string | null };

export type SessionView<S extends SessionLike> = {
  phase: SessionPhase;
  /** Newest session for this scenario, whatever its status. */
  latest: S | null;
  /** `latest` when it is active. */
  live: S | null;
  /** `latest` when it has ended. */
  ended: S | null;
  /** An active session for a different scenario. */
  blocking: S | null;
  /** The live session's pod is up and it has a workspace URL. */
  usable: boolean;
  /** The page should call `sessions.request` now. */
  shouldRequest: boolean;
  /** Human-readable reason the latest session ended. */
  endedReason: string | null;
  /** The request error that still applies, if any. */
  requestError: string | null;
};

export function endedReason(session: Pick<SessionLike, "status" | "stopReason" | "lastCheckSummary">) {
  const detail = session.stopReason ?? (session.status === "errored" ? session.lastCheckSummary : undefined);
  const base =
    session.status === "expired"
      ? "This session expired"
      : session.status === "errored"
        ? "This session failed"
        : "This session was stopped";
  return detail ? `${base}: ${detail}` : `${base}.`;
}

export function deriveSessionView<S extends SessionLike>(input: SessionInput<S>): SessionView<S> {
  const empty: SessionView<S> = {
    phase: "loading",
    latest: null,
    live: null,
    ended: null,
    blocking: null,
    usable: false,
    shouldRequest: false,
    endedReason: null,
    requestError: null,
  };
  const { sessions, labId } = input;
  if (sessions === undefined || labId === null) return empty;

  const latest = sessions.find((session) => session.labId === labId) ?? null;
  const blocking =
    sessions.find((session) => session.labId !== labId && ACTIVE_STATUSES.has(session.status)) ?? null;
  const live = latest && ACTIVE_STATUSES.has(latest.status) ? latest : null;
  const ended = latest && !live ? latest : null;
  const pendingVisible = input.pendingId !== null && sessions.some((session) => session._id === input.pendingId);
  const waiting = input.inFlight || (input.pendingId !== null && !pendingVisible);
  const view = { ...empty, latest, live, ended, blocking };

  if (live) {
    return {
      ...view,
      phase: "live",
      usable: USABLE_STATUSES.has(live.status) && Boolean(live.workspaceUrl),
    };
  }
  if (waiting) return { ...view, phase: "requesting" };
  const requestError =
    input.requestError && input.requestError.latestId === (latest?._id ?? null) ? input.requestError.message : null;
  if (requestError) return { ...view, phase: "request-error", requestError };
  if (blocking) return { ...view, phase: "blocked" };
  if (ended) return { ...view, phase: "ended", endedReason: endedReason(ended) };
  if (!input.requested) return { ...view, phase: "requesting", shouldRequest: true };
  return { ...view, phase: "idle" };
}

/**
 * Short message for an error from a Convex mutation or the gateway. Convex
 * wraps server errors as "[CONVEX M(mod:fn)] [Request ID: …] Server Error
 * Uncaught Error: <message>\n    at handler (…)"; keep the <message>.
 */
export function errorMessage(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  const match = /Uncaught Error: ([^\n]*)/.exec(text);
  return (match ? match[1] : text).trim() || "Unknown error";
}
