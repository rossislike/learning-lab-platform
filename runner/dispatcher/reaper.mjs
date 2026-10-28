#!/usr/bin/env node
// In-cluster TTL reaper (ROADMAP Phase 6): a CronJob that deletes session
// pods the dispatcher should already have removed. It needs no Convex access
// and no shared secret, so it keeps working when the control plane or the
// dispatcher is down. Two rules, both with a grace period so it never races
// a healthy dispatcher:
//   - a pod past its `learning-lab/expires-at` annotation by more than
//     EXPIRED_GRACE_SECONDS (the kubelet's activeDeadlineSeconds should have
//     ended it; this is the belt to that suspenders),
//   - a pod in phase Failed or Succeeded for longer than FINISHED_GRACE_SECONDS
//     (the dispatcher deletes these within a tick when it is alive).
// Environment: SESSIONS_NAMESPACE (sessions), KUBERNETES_MODE (auto),
// EXPIRED_GRACE_SECONDS (600), FINISHED_GRACE_SECONDS (300), DRY_RUN (false).

import { pathToFileURL } from "node:url"
import { createKubernetesClient, podPhase } from "./k8s.mjs"
import { SESSION_LABEL, SESSION_LABEL_VALUE, SESSION_ID_LABEL } from "./pod-spec.mjs"

export const EXPIRES_AT_ANNOTATION = "learning-lab/expires-at"

/**
 * Pure selection: which of `pods` to delete at `now` (ms), and why.
 * @returns {{ name: string, sessionId?: string, reason: string }[]}
 */
export function selectPodsToReap(pods, { now = Date.now(), expiredGraceMs = 600_000, finishedGraceMs = 300_000 } = {}) {
  const victims = []
  for (const pod of pods) {
    const name = pod?.metadata?.name
    if (!name) continue
    const sessionId = pod.metadata.labels?.[SESSION_ID_LABEL]
    const phase = podPhase(pod)
    const expiresAt = Date.parse(pod.metadata.annotations?.[EXPIRES_AT_ANNOTATION] ?? "")
    if (Number.isFinite(expiresAt) && now - expiresAt > expiredGraceMs) {
      victims.push({ name, sessionId, reason: `expired ${Math.round((now - expiresAt) / 60_000)} min ago` })
      continue
    }
    if (phase === "Failed" || phase === "Succeeded") {
      const finishedAt = finishedAtOf(pod, now)
      if (now - finishedAt > finishedGraceMs) {
        victims.push({ name, sessionId, reason: `${phase.toLowerCase()} ${Math.round((now - finishedAt) / 60_000)} min ago` })
      }
    }
  }
  return victims
}

/**
 * When a finished pod finished: the latest container termination or pod
 * condition transition (Ready/ContainersReady flip to False when it ends;
 * the latest one is the conservative choice), else its creation time, else
 * `now` (never reaped on this run). Date.parse returns NaN, not null, so the
 * fallbacks are chained on Number.isFinite.
 */
export function finishedAtOf(pod, now) {
  const statuses = [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])]
  const times = [
    ...statuses.map((status) => Date.parse(status.state?.terminated?.finishedAt ?? status.lastState?.terminated?.finishedAt ?? "")),
    ...(pod.status?.conditions ?? []).map((condition) => Date.parse(condition.lastTransitionTime ?? "")),
  ].filter((value) => Number.isFinite(value))
  if (times.length > 0) return Math.max(...times)
  const created = Date.parse(pod.metadata?.creationTimestamp ?? "")
  return Number.isFinite(created) ? created : now
}

export async function reap({ k8s, logger = console, now = Date.now(), dryRun = false, ...options }) {
  const pods = await k8s.listPods(`${SESSION_LABEL}=${SESSION_LABEL_VALUE}`)
  const victims = selectPodsToReap(pods, { now, ...options })
  let deleted = 0
  for (const victim of victims) {
    logger.warn?.(`[reaper] ${dryRun ? "would delete" : "deleting"} pod ${victim.name} (session ${victim.sessionId ?? "unknown"}): ${victim.reason}`)
    if (dryRun) continue
    if (await k8s.deletePod(victim.name)) deleted += 1
  }
  logger.info?.(`[reaper] ${pods.length} session pod(s), ${victims.length} to reap, ${deleted} deleted`)
  return { scanned: pods.length, selected: victims.length, deleted }
}

async function main() {
  const namespace = process.env.SESSIONS_NAMESPACE ?? "sessions"
  const k8s = await createKubernetesClient({ mode: process.env.KUBERNETES_MODE ?? "auto", namespace })
  const seconds = (name, fallback) => Number(process.env[name] ?? fallback) * 1000
  const result = await reap({
    k8s,
    dryRun: process.env.DRY_RUN === "true",
    expiredGraceMs: seconds("EXPIRED_GRACE_SECONDS", 600),
    finishedGraceMs: seconds("FINISHED_GRACE_SECONDS", 300),
  })
  console.log(`[reaper] done ${JSON.stringify(result)}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[reaper] fatal: ${error.stack ?? error}`)
    process.exit(1)
  })
}
