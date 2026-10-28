export type SessionLifecycleStatus =
  | "requested"
  | "starting"
  | "running"
  | "checking"
  | "passed"
  | "failed"
  | "stopping"
  | "stopped"
  | "errored"
  | "expired"

export const ACTIVE_SESSION_STATUSES = new Set<SessionLifecycleStatus>([
  "requested",
  "starting",
  "running",
  "checking",
  "passed",
  "failed",
  "stopping",
])

export function isActiveSessionStatus(status: SessionLifecycleStatus) {
  return ACTIVE_SESSION_STATUSES.has(status)
}

export const CLEANUP_SESSION_STATUSES = new Set<SessionLifecycleStatus>([
  "stopping",
  "stopped",
  "expired",
  "errored",
])

export function canBeginStartup(status: SessionLifecycleStatus) {
  return status === "requested"
}

export function canPublishStartup(status: SessionLifecycleStatus) {
  return status === "starting"
}

export function canUpdateRunnerMetadata(status: SessionLifecycleStatus) {
  return ["starting", "running", "checking", "passed", "failed"].includes(status)
}

export function canUseWorkspace(status: SessionLifecycleStatus) {
  return ["running", "checking", "passed", "failed"].includes(status)
}

export function canRequestStop(status: SessionLifecycleStatus) {
  return !["stopped", "expired", "errored"].includes(status)
}

export function canExpire(status: SessionLifecycleStatus) {
  return !["stopping", "stopped", "expired", "errored"].includes(status)
}

export function canMarkCleaned(status: SessionLifecycleStatus) {
  return CLEANUP_SESSION_STATUSES.has(status)
}

/**
 * Statuses a session can be expired from (the TTL still applies). Queries for
 * past-TTL sessions go per status through `by_status` so they never scan the
 * unbounded history of ended sessions: a global `by_expires_at` window would
 * fill up with stopped/expired/errored rows (their expiresAt is in the past
 * too) and hide a live session once ~100 sessions have finished.
 */
export const EXPIRABLE_SESSION_STATUSES: SessionLifecycleStatus[] = [...ACTIVE_SESSION_STATUSES].filter(canExpire)

/** Past-TTL sessions that may still be expired, oldest expiry first. */
export function selectExpiredSessions<T extends { status: SessionLifecycleStatus; expiresAt: number }>(
  sessions: T[],
  cutoff: number,
): T[] {
  return sessions
    .filter((session) => session.expiresAt < cutoff && canExpire(session.status))
    .sort((a, b) => a.expiresAt - b.expiresAt)
}
