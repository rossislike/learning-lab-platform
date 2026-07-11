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
