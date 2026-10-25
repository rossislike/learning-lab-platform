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

export function createDispatcher({
  convex,
  k8s,
  config,
  logger = console,
  now = () => Date.now(),
  random = randomBytes,
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

  async function markErrored(session, message) {
    stats.errored += 1
    logger.error?.(`[dispatcher] ${session._id}: ${message}`)
    await convex.mutation("sessions:markErrored", { sessionId: session._id, message })
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

  async function launch(session, lab) {
    const routeId = session.routeId ?? randomRouteId(random)
    const { token } = await convex.mutation("sessions:issueAgentToken", { sessionId: session._id })
    const spec = buildPodSpec({ session, lab, routeId, agentToken: token, config })
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
    logger.info?.(`[dispatcher] ${session._id}: created pod ${spec.metadata.name} (route ${routeId})`)
  }

  async function handleStartable({ session, lab }) {
    if (!lab) return markErrored(session, "Scenario no longer exists")
    if (!lab.sourceDir || lab.manifestVersion !== 2) return markErrored(session, "Scenario is not a v2 bundle")
    if (session.status === "requested") {
      const began = await convex.mutation("sessions:markStarting", { sessionId: session._id })
      if (!began) return
    }
    const podName = session.podName ?? podNameFor(session._id)
    const pod = await k8s.getPod(podName)
    if (!pod) return launch(session, lab)

    const phase = podPhase(pod)
    if (phase === "Failed" || phase === "Succeeded") {
      await k8s.deletePod(podName)
      return markErrored(session, `Session pod ${phase.toLowerCase()} before it became ready`)
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
        await markErrored({ _id: entry.sessionId }, `Session pod ${podName} is gone${phase ? ` (${phase.toLowerCase()})` : ""}`)
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
    await heartbeat()
    if (!(await holdsLease())) return { skipped: "lease" }
    const work = await convex.query("sessions:listForDispatcher")
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
