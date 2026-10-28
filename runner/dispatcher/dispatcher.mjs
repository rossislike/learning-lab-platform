// The Kubernetes dispatcher (ADR 0005): turns Convex sessions into pods.
//
// Each tick (idempotent, safe to repeat after a crash):
//   heartbeat → lease → listForDispatcher →
//     requested/starting: markStarting → issueAgentToken → record routeId/podName/ports →
//                         create pod → wait for kubelet Ready → markRunning
//     expired:            markExpired
//     cleanup:            delete pod → markCleaned
//     orphans:            delete session pods Convex no longer considers active
//     lost pods:          error running sessions whose pod is gone or finished
//
// Dependencies are injected (convex, k8s, clock, random) so the loop is
// unit-tested against in-memory fakes.

import { randomBytes } from "node:crypto"
import { hostname } from "node:os"
import { buildPodSpec, podNameFor, ROUTE_ID_LABEL, SESSION_ID_LABEL, SESSION_LABEL, SESSION_LABEL_VALUE } from "./pod-spec.mjs"
import { podIsReady, podPhase } from "./k8s.mjs"

export const LEASE_NAME = "dispatcher"

export function randomRouteId(random = randomBytes) {
  // 24 lowercase base32-ish chars (~120 bits), matches ROUTE_ID_PATTERN.
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
  const bytes = random(24)
  let out = ""
  for (const byte of bytes) out += alphabet[byte % alphabet.length]
  return out
}

export function endpointUrls({ routeId, hostSuffix, scheme = "http", port, hasPreview }) {
  const portSuffix = port && !((scheme === "http" && port === 80) || (scheme === "https" && port === 443)) ? `:${port}` : ""
  const workspaceUrl = `${scheme}://ws-${routeId}.${hostSuffix}${portSuffix}`
  return {
    workspaceUrl,
    terminalUrl: workspaceUrl,
    previewUrl: hasPreview ? `${scheme}://pv-${routeId}.${hostSuffix}${portSuffix}` : undefined,
  }
}

/** The one bundle problem retrying cannot fix: the session row has no approval. */
export class MissingBundleApprovalError extends Error {}

/**
 * The scenario shape a pod is built from. In s3 mode the session carries the
 * runtime contract that was approved with its bundle (hostedScenario.runtime:
 * kind, workspace, tabs, react.previewPort), so the pod matches the bundle
 * even if the live labs row has moved on since. slug and sourceDir still
 * come from the labs row.
 */
export function scenarioRuntimeFor(session, lab, bundleMode) {
  const runtime = bundleMode === "s3" ? session.hostedScenario?.runtime : undefined
  return runtime ? { ...lab, ...runtime } : lab
}

/**
 * " (bundle exited 1: Error)" — which container terminated and how, from the
 * pod status, so a failed session explains itself without racing `kubectl
 * logs` against the cleanup.
 */
export function podFailureDetail(pod) {
  const statuses = [...(pod?.status?.initContainerStatuses ?? []), ...(pod?.status?.containerStatuses ?? [])]
  const parts = []
  for (const status of statuses) {
    const terminated = status.state?.terminated ?? status.lastState?.terminated
    if (!terminated || terminated.exitCode === 0) continue
    const reason = terminated.reason && terminated.reason !== "Error" ? `: ${terminated.reason}` : ""
    const message = terminated.message ? ` — ${String(terminated.message).trim().slice(0, 200)}` : ""
    parts.push(`${status.name} exited ${terminated.exitCode}${reason}${message}`)
  }
  if (parts.length === 0 && pod?.status?.reason) parts.push(pod.status.reason)
  return parts.length > 0 ? ` (${parts.join("; ")})` : ""
}

export function createDispatcher({
  convex,
  k8s,
  config,
  logger = console,
  now = () => Date.now(),
  random = randomBytes,
  presignBundle, // s3 bundle mode: async ({ key, sha256 }) => https URL
  metrics, // optional: createMetricsPublisher() — Heartbeat, ActiveSessions, LaunchFailures, LostPods, PodsLaunched
}) {
  const runnerId = config.runnerId ?? `dispatcher-${hostname()}-${process.pid}`
  const pollMs = config.pollMs ?? 3000
  const startupTimeoutMs = config.startupTimeoutMs ?? 10 * 60 * 1000
  const stats = { ticks: 0, launched: 0, running: 0, errored: 0, cleaned: 0, orphansDeleted: 0, leaseHeld: false }

  async function heartbeat() {
    await convex.mutation("runners:heartbeat", { runner: "kubernetes", runnerId, pollMs, pid: process.pid, hostname: hostname() })
  }

  async function holdsLease() {
    stats.leaseHeld = await convex.mutation("runners:acquireLease", {
      name: LEASE_NAME,
      holder: runnerId,
      ttlMs: Math.max(pollMs * 4, 10_000),
    })
    return stats.leaseHeld
  }

  /**
   * `metric` names the CloudWatch counter: LaunchFailures for the startup
   * path (alarmed on), LostPods for running sessions whose pod disappeared
   * (reconcilePods). Counted only once Convex accepted the transition.
   */
  async function markErrored(session, message, metric = "LaunchFailures") {
    logger.error?.(`[dispatcher] ${session._id}: ${message}`)
    const changed = await convex.mutation("sessions:markErrored", { sessionId: session._id, message })
    if (changed === false) return
    stats.errored += 1
    metrics?.count(metric)
  }

  function metadataFor(session, lab, routeId, podName) {
    return {
      sessionId: session._id,
      routeId,
      podName,
      runnerResourceId: podName,
      agentPort: config.agentPort ?? 7000,
      ...(lab.kind === "react" && lab.react?.previewPort ? { previewPort: lab.react.previewPort } : {}),
    }
  }

  async function bundleDownloadFor(session) {
    if (config.bundle?.mode !== "s3") return undefined
    const approved = session.hostedScenario
    if (!approved?.artifactKey || !approved?.artifactSha256) {
      throw new MissingBundleApprovalError("session has no approved scenario bundle (hostedScenario); publish and approve it first")
    }
    if (typeof presignBundle !== "function") throw new Error("s3 bundle mode needs a presignBundle function")
    const url = await presignBundle({ key: approved.artifactKey, sha256: approved.artifactSha256 })
    return { url, sha256: approved.artifactSha256 }
  }

  async function launch(session, lab) {
    const routeId = session.routeId ?? randomRouteId(random)
    let bundleDownload
    try {
      bundleDownload = await bundleDownloadFor(session)
    } catch (error) {
      // Only a missing approval is final. Credential or presign failures
      // (Pod Identity agent restarting, a network blip, …) are thrown, logged
      // by tick() and retried on the next tick, until the startup timeout.
      if (error instanceof MissingBundleApprovalError) return markErrored(session, `Scenario bundle unavailable: ${error.message}`)
      if (now() - session.updatedAt > startupTimeoutMs) return markErrored(session, `Scenario bundle unavailable: ${error.message}`)
      throw error
    }
    const { token } = await convex.mutation("sessions:issueAgentToken", { sessionId: session._id })
    const spec = buildPodSpec({ session, lab, routeId, agentToken: token, config, bundleDownload })
    // Persist the routing metadata BEFORE the pod exists: a crash between
    // createPod and this write would otherwise leave a pod whose routeId
    // Convex never learned (the Ready branch also back-fills from the pod
    // labels as a second line of defence).
    await convex.mutation("sessions:updateRunnerMetadata", metadataFor(session, lab, routeId, spec.metadata.name))
    try {
      await k8s.createPod(spec)
    } catch (error) {
      if (error.status !== 409) throw error // 409 = already exists (lost race with ourselves)
    }
    stats.launched += 1
    metrics?.count("PodsLaunched")
    logger.info?.(`[dispatcher] ${session._id}: created pod ${spec.metadata.name} (route ${routeId})`)
  }

  async function handleStartable({ session, lab: labRow }) {
    if (!labRow) return markErrored(session, "Scenario no longer exists")
    if (!labRow.sourceDir || labRow.manifestVersion !== 2) return markErrored(session, "Scenario is not a v2 bundle")
    const lab = scenarioRuntimeFor(session, labRow, config.bundle?.mode)
    const wasStarting = session.status === "starting"
    if (session.status === "requested") {
      const began = await convex.mutation("sessions:markStarting", { sessionId: session._id })
      if (!began) return
    }
    const podName = session.podName ?? podNameFor(session._id)
    const pod = await k8s.getPod(podName)
    if (!pod) {
      // A pod was created for this start (podName persisted) but is gone, e.g.
      // the reaper removed it after it failed: past the startup timeout, give
      // up instead of relaunching it forever.
      if (wasStarting && session.podName && now() - session.updatedAt > startupTimeoutMs) {
        return markErrored(session, `Session pod ${podName} disappeared and the session did not start within ${Math.round(startupTimeoutMs / 1000)} s`)
      }
      return launch(session, lab)
    }

    const phase = podPhase(pod)
    if (phase === "Failed" || phase === "Succeeded") {
      await k8s.deletePod(podName)
      return markErrored(session, `Session pod ${phase.toLowerCase()} before it became ready${podFailureDetail(pod)}`)
    }
    if (now() - session.updatedAt > startupTimeoutMs) {
      await k8s.deletePod(podName)
      return markErrored(session, `Session pod did not become ready within ${Math.round(startupTimeoutMs / 1000)} s`)
    }
    if (!podIsReady(pod)) return
    const routeId = session.routeId ?? pod.metadata?.labels?.[ROUTE_ID_LABEL]
    if (!routeId) {
      await k8s.deletePod(podName)
      return markErrored(session, "Session pod has no route id")
    }
    const expected = metadataFor(session, lab, routeId, podName)
    const missing = Object.keys(expected).some((key) => key !== "sessionId" && session[key] !== expected[key])
    await convex.mutation("sessions:updateRunnerMetadata", {
      ...(missing ? expected : { sessionId: session._id }),
      podIp: pod.status.podIP,
    })
    const urls = endpointUrls({
      routeId,
      hostSuffix: config.hostSuffix,
      scheme: config.publicScheme,
      port: config.publicPort,
      hasPreview: (lab.tabs ?? []).includes("preview"),
    })
    await convex.mutation("sessions:markRunning", { sessionId: session._id, ...urls })
    stats.running += 1
    logger.info?.(`[dispatcher] ${session._id}: running at ${urls.workspaceUrl} (pod ${pod.status.podIP})`)
  }

  async function handleCleanup(session) {
    const podName = session.podName ?? podNameFor(session._id)
    const deleted = await k8s.deletePod(podName)
    await convex.mutation("sessions:markCleaned", {
      sessionId: session._id,
      summary: deleted ? `Session pod ${podName} deleted` : `Session pod ${podName} was already gone`,
    })
    stats.cleaned += 1
  }

  const LOST_POD_STATUSES = new Set(["running", "checking", "passed", "failed"])

  /**
   * Orphans: session pods Convex no longer considers active are deleted.
   * Lost pods: a session Convex considers usable whose pod is gone or has
   * finished (killed by activeDeadlineSeconds, evicted, OOM, node loss) is
   * errored so the learner is not left with a dead workspace.
   */
  async function reconcilePods(active) {
    const known = new Set(active.map((entry) => String(entry.sessionId)))
    const pods = await k8s.listPods(`${SESSION_LABEL}=${SESSION_LABEL_VALUE}`)
    const byName = new Map(pods.map((pod) => [pod.metadata?.name, pod]))
    for (const entry of active) {
      if (!LOST_POD_STATUSES.has(entry.status)) continue
      const podName = entry.podName ?? podNameFor(entry.sessionId)
      const pod = byName.get(podName)
      const phase = pod ? podPhase(pod) : null
      if (pod && phase !== "Failed" && phase !== "Succeeded") continue
      try {
        if (pod) await k8s.deletePod(podName)
        await markErrored({ _id: entry.sessionId }, `Session pod ${podName} is gone${phase ? ` (${phase.toLowerCase()})` : ""}`, "LostPods")
      } catch (error) {
        logger.error?.(`[dispatcher] lost pod ${podName}: ${error.stack ?? error}`)
      }
    }
    for (const pod of pods) {
      const sessionId = pod.metadata?.labels?.[SESSION_ID_LABEL]
      if (sessionId && known.has(sessionId)) continue
      // Give a freshly created pod a moment before treating it as orphaned.
      const createdAt = Date.parse(pod.metadata?.creationTimestamp ?? "") || 0
      if (now() - createdAt < 60_000) continue
      logger.warn?.(`[dispatcher] deleting orphan pod ${pod.metadata?.name} (session ${sessionId ?? "unknown"})`)
      await k8s.deletePod(pod.metadata.name)
      stats.orphansDeleted += 1
    }
  }

  async function tick() {
    stats.ticks += 1
    try {
      return await tickBody()
    } finally {
      // Also after a failed tick, so LaunchFailures/LostPods counted before
      // the failure still reach CloudWatch (flush never throws).
      await metrics?.flush()
    }
  }

  async function tickBody() {
    await heartbeat()
    metrics?.count("Heartbeat")
    if (!(await holdsLease())) return { skipped: "lease" }
    const work = await convex.query("sessions:listForDispatcher")
    metrics?.gauge("ActiveSessions", work.active.length)
    for (const entry of work.startable) {
      try {
        await handleStartable(entry)
      } catch (error) {
        logger.error?.(`[dispatcher] ${entry.session._id}: ${error.stack ?? error}`)
      }
    }
    for (const session of work.expired) {
      await convex.mutation("sessions:markExpired", { sessionId: session._id }).catch((error) =>
        logger.error?.(`[dispatcher] expire ${session._id}: ${error.message}`),
      )
    }
    for (const session of work.cleanup) {
      try {
        await handleCleanup(session)
      } catch (error) {
        logger.error?.(`[dispatcher] cleanup ${session._id}: ${error.stack ?? error}`)
      }
    }
    try {
      await reconcilePods(work.active)
    } catch (error) {
      logger.error?.(`[dispatcher] reconcile: ${error.stack ?? error}`)
    }
    return { skipped: null }
  }

  async function run(signal) {
    logger.info?.(`[dispatcher] ${runnerId} polling every ${pollMs} ms; namespace ${config.namespace}; image ${config.image}`)
    while (!signal?.aborted) {
      try {
        await tick()
      } catch (error) {
        logger.error?.(`[dispatcher] tick failed: ${error.stack ?? error}`)
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, pollMs)
        signal?.addEventListener("abort", () => {
          clearTimeout(timer)
          resolve()
        }, { once: true })
      })
    }
  }

  return { tick, run, stats, runnerId }
}
