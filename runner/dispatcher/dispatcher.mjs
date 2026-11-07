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
const DEFAULT_POLL_MS = 3000
const DEFAULT_STARTUP_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_AGENT_PORT = 7000
const MIN_LEASE_TTL_MS = 10_000
const LEASE_TTL_POLLS = 4
// A pod younger than this may belong to a session Convex has not listed yet.
const ORPHAN_GRACE_MS = 60_000
const POD_ALREADY_EXISTS = 409
const FINISHED_POD_PHASES = new Set(["Failed", "Succeeded"])
// Sessions Convex still considers usable; their pod must exist (reconcilePods).
const USABLE_SESSION_STATUSES = new Set(["running", "checking", "passed", "failed"])
const NOOP_METRICS = Object.freeze({ count() {}, gauge() {}, flush: async () => {} })
const SUPPORTED_MANIFEST_VERSION = 2
const ROUTE_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"
const ROUTE_ID_LENGTH = 24
const MAX_TERMINATION_MESSAGE_CHARS = 200

export function randomRouteId(random = randomBytes) {
  // ROUTE_ID_LENGTH lowercase base32-ish chars (~120 bits), matches ROUTE_ID_PATTERN.
  const bytes = random(ROUTE_ID_LENGTH)
  let out = ""
  for (const byte of bytes) out += ROUTE_ID_ALPHABET[byte % ROUTE_ID_ALPHABET.length]
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
    const message = terminated.message ? ` \u2014 ${String(terminated.message).trim().slice(0, MAX_TERMINATION_MESSAGE_CHARS)}` : ""
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
  metrics: suppliedMetrics, // optional createMetricsPublisher(): Heartbeat, ActiveSessions, LaunchFailures, LostPods, PodsLaunched
}) {
  const metrics = suppliedMetrics ?? NOOP_METRICS
  const runnerId = config.runnerId ?? `dispatcher-${hostname()}-${process.pid}`
  const pollMs = config.pollMs ?? DEFAULT_POLL_MS
  const startupTimeoutMs = config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
  const agentPort = config.agentPort ?? DEFAULT_AGENT_PORT
  const stats = { ticks: 0, launched: 0, running: 0, errored: 0, cleaned: 0, orphansDeleted: 0, leaseHeld: false }

  // --- The loop -------------------------------------------------------------

  async function run(signal) {
    logger.info?.(`[dispatcher] ${runnerId} polling every ${pollMs} ms; namespace ${config.namespace}; image ${config.image}`)
    while (!signal?.aborted) {
      await runIsolated("tick failed", tick)
      await sleep(pollMs, signal)
    }
  }

  async function tick() {
    stats.ticks += 1
    try {
      return await tickBody()
    } finally {
      // Also after a failed tick, so LaunchFailures/LostPods counted before
      // the failure still reach CloudWatch (flush never throws).
      await metrics.flush()
    }
  }

  async function tickBody() {
    await heartbeat()
    if (!(await holdsLease())) return { skipped: "lease" }
    const work = await convex.query("sessions:listForDispatcher")
    metrics.gauge("ActiveSessions", work.active.length)
    for (const entry of work.startable) await runIsolated(entry.session._id, () => handleStartable(entry))
    for (const session of work.expired) {
      await convex.mutation("sessions:markExpired", { sessionId: session._id }).catch((error) =>
        logger.error?.(`[dispatcher] expire ${session._id}: ${error.message}`),
      )
    }
    for (const session of work.cleanup) await runIsolated(`cleanup ${session._id}`, () => handleCleanup(session))
    await runIsolated("reconcile", () => reconcilePods(work.active))
    return { skipped: null }
  }

  /** Runs one unit of tick work; a failure is logged and never stops the rest of the tick. */
  async function runIsolated(label, work) {
    try {
      await work()
    } catch (error) {
      logger.error?.(`[dispatcher] ${label}: ${error.stack ?? error}`)
    }
  }

  function sleep(ms, signal) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      signal?.addEventListener("abort", () => {
        clearTimeout(timer)
        resolve()
      }, { once: true })
    })
  }

  // --- Convex side ----------------------------------------------------------

  async function heartbeat() {
    await convex.mutation("runners:heartbeat", { runner: "kubernetes", runnerId, pollMs, pid: process.pid, hostname: hostname() })
    metrics.count("Heartbeat")
  }

  async function holdsLease() {
    stats.leaseHeld = await convex.mutation("runners:acquireLease", {
      name: LEASE_NAME,
      holder: runnerId,
      ttlMs: Math.max(pollMs * LEASE_TTL_POLLS, MIN_LEASE_TTL_MS),
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
    metrics.count(metric)
  }

  /**
   * True when this tick may proceed with the start: the session was already
   * starting, or it was requested and Convex accepted markStarting.
   */
  async function claimStart(session) {
    if (session.status !== "requested") return true
    return await convex.mutation("sessions:markStarting", { sessionId: session._id })
  }

  function runnerMetadataFor(session, lab, routeId, podName) {
    return {
      sessionId: session._id,
      routeId,
      podName,
      runnerResourceId: podName,
      agentPort,
      ...(lab.kind === "react" && lab.react?.previewPort ? { previewPort: lab.react.previewPort } : {}),
    }
  }

  function runnerMetadataIsStale(session, expected) {
    return Object.keys(expected).some((key) => key !== "sessionId" && session[key] !== expected[key])
  }

  // --- Startup --------------------------------------------------------------

  async function handleStartable({ session, lab: labRow }) {
    if (!labRow) return markErrored(session, "Scenario no longer exists")
    if (!labRow.sourceDir || labRow.manifestVersion !== SUPPORTED_MANIFEST_VERSION) return markErrored(session, "Scenario is not a v2 bundle")
    const lab = scenarioRuntimeFor(session, labRow, config.bundle?.mode)
    const wasStarting = session.status === "starting"
    if (!(await claimStart(session))) return

    const podName = session.podName ?? podNameFor(session._id)
    const pod = await k8s.getPod(podName)
    if (!pod) return handleMissingPod(session, lab, podName, { wasStarting })

    const phase = podPhase(pod)
    if (FINISHED_POD_PHASES.has(phase)) {
      return deletePodAndFail(session, podName, `Session pod ${phase.toLowerCase()} before it became ready${podFailureDetail(pod)}`)
    }
    if (startupTimedOut(session)) {
      return deletePodAndFail(session, podName, `Session pod did not become ready within ${startupTimeoutSeconds()} s`)
    }
    if (!podIsReady(pod)) return
    const routeId = session.routeId ?? pod.metadata?.labels?.[ROUTE_ID_LABEL]
    if (!routeId) return deletePodAndFail(session, podName, "Session pod has no route id")
    return publishRunning(session, lab, pod, routeId, podName)
  }

  /**
   * A pod was created for this start (podName persisted) but is gone, e.g.
   * the reaper removed it after it failed: past the startup timeout, give up
   * instead of relaunching it forever.
   */
  async function handleMissingPod(session, lab, podName, { wasStarting }) {
    if (wasStarting && session.podName && startupTimedOut(session)) {
      return markErrored(session, `Session pod ${podName} disappeared and the session did not start within ${startupTimeoutSeconds()} s`)
    }
    return launch(session, lab)
  }

  async function deletePodAndFail(session, podName, message) {
    await k8s.deletePod(podName)
    return markErrored(session, message)
  }

  async function launch(session, lab) {
    const routeId = session.routeId ?? randomRouteId(random)
    let bundleDownload
    try {
      bundleDownload = await bundleDownloadFor(session)
    } catch (error) {
      if (isFinalBundleFailure(session, error)) return markErrored(session, `Scenario bundle unavailable: ${error.message}`)
      throw error
    }
    const { token } = await convex.mutation("sessions:issueAgentToken", { sessionId: session._id })
    const spec = buildPodSpec({ session, lab, routeId, agentToken: token, config, bundleDownload })
    // Persist the routing metadata BEFORE the pod exists: a crash between
    // createPod and this write would otherwise leave a pod whose routeId
    // Convex never learned (publishRunning also back-fills from the pod
    // labels as a second line of defence).
    await convex.mutation("sessions:updateRunnerMetadata", runnerMetadataFor(session, lab, routeId, spec.metadata.name))
    await createPodIgnoringDuplicate(spec)
    stats.launched += 1
    metrics.count("PodsLaunched")
    logger.info?.(`[dispatcher] ${session._id}: created pod ${spec.metadata.name} (route ${routeId})`)
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

  /**
   * Only a missing approval is final. Credential or presign failures (Pod
   * Identity agent restarting, a network blip, ...) are thrown, logged by
   * tick() and retried on the next tick, until the startup timeout.
   */
  function isFinalBundleFailure(session, error) {
    return error instanceof MissingBundleApprovalError || startupTimedOut(session)
  }

  async function createPodIgnoringDuplicate(spec) {
    try {
      await k8s.createPod(spec)
    } catch (error) {
      if (error.status !== POD_ALREADY_EXISTS) throw error // lost a race with ourselves
    }
  }

  async function publishRunning(session, lab, pod, routeId, podName) {
    const expected = runnerMetadataFor(session, lab, routeId, podName)
    await convex.mutation("sessions:updateRunnerMetadata", {
      ...(runnerMetadataIsStale(session, expected) ? expected : { sessionId: session._id }),
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

  function startupTimedOut(session) {
    return now() - session.updatedAt > startupTimeoutMs
  }

  function startupTimeoutSeconds() {
    return Math.round(startupTimeoutMs / 1000)
  }

  // --- Teardown and reconciliation -----------------------------------------

  async function handleCleanup(session) {
    const podName = session.podName ?? podNameFor(session._id)
    const deleted = await k8s.deletePod(podName)
    await convex.mutation("sessions:markCleaned", {
      sessionId: session._id,
      summary: deleted ? `Session pod ${podName} deleted` : `Session pod ${podName} was already gone`,
    })
    stats.cleaned += 1
  }

  async function reconcilePods(active) {
    const pods = await k8s.listPods(`${SESSION_LABEL}=${SESSION_LABEL_VALUE}`)
    const podsByName = new Map(pods.map((pod) => [pod.metadata?.name, pod]))
    await errorLostPods(active, podsByName)
    await deleteOrphanPods(active, pods)
  }

  /**
   * A session Convex considers usable whose pod is gone or has finished
   * (killed by activeDeadlineSeconds, evicted, OOM, node loss) is errored so
   * the learner is not left with a dead workspace.
   */
  async function errorLostPods(active, podsByName) {
    for (const entry of active) {
      if (!USABLE_SESSION_STATUSES.has(entry.status)) continue
      const podName = entry.podName ?? podNameFor(entry.sessionId)
      const pod = podsByName.get(podName)
      const phase = pod ? podPhase(pod) : null
      if (pod && !FINISHED_POD_PHASES.has(phase)) continue
      try {
        if (pod) await k8s.deletePod(podName)
        await markErrored({ _id: entry.sessionId }, `Session pod ${podName} is gone${phase ? ` (${phase.toLowerCase()})` : ""}`, "LostPods")
      } catch (error) {
        logger.error?.(`[dispatcher] lost pod ${podName}: ${error.stack ?? error}`)
      }
    }
  }

  /** Session pods Convex no longer considers active are deleted. */
  async function deleteOrphanPods(active, pods) {
    const known = new Set(active.map((entry) => String(entry.sessionId)))
    for (const pod of pods) {
      const sessionId = pod.metadata?.labels?.[SESSION_ID_LABEL]
      if (sessionId && known.has(sessionId)) continue
      const createdAt = Date.parse(pod.metadata?.creationTimestamp ?? "") || 0
      if (now() - createdAt < ORPHAN_GRACE_MS) continue
      logger.warn?.(`[dispatcher] deleting orphan pod ${pod.metadata?.name} (session ${sessionId ?? "unknown"})`)
      await k8s.deletePod(pod.metadata.name)
      stats.orphansDeleted += 1
    }
  }

  return { tick, run, stats, runnerId }
}
