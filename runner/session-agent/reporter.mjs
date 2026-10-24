// Reports step results to Convex over its HTTP API using the session-bound
// agent token (never the runner secret). `recordStepResult` resolves — never
// rejects — with { reported, value | error }, so the verify response can say
// whether Convex has the result. Transport failures and 5xx are retried with
// a per-attempt timeout under a total deadline; application errors returned
// by Convex (`status: "error"`, 4xx) are not retried.

const MAX_ATTEMPTS = 3
const ATTEMPT_TIMEOUT_MS = 8000
const TOTAL_TIMEOUT_MS = 15_000

export function createReporter({
  convexUrl,
  sessionId,
  sessionToken,
  logger = console,
  fetchImpl = globalThis.fetch,
  attemptTimeoutMs = ATTEMPT_TIMEOUT_MS,
  totalTimeoutMs = TOTAL_TIMEOUT_MS,
}) {
  if (!convexUrl || !sessionId || !sessionToken) {
    logger.info?.("[reporter] CONVEX_URL/SESSION_ID/SESSION_TOKEN not set; results stay local")
    return { enabled: false, recordStepResult: async () => ({ reported: false }) }
  }
  const endpoint = new URL("/api/mutation", convexUrl).toString()

  async function mutation(path, args) {
    const deadline = Date.now() + totalTimeoutMs
    let lastError
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      // A ref'd timer rather than AbortSignal.timeout(), whose timer is unref'd
      // and so cannot fire when nothing else keeps the event loop alive.
      const controller = new AbortController()
      const timer = setTimeout(
        () => controller.abort(new Error(`timed out after ${attemptTimeoutMs} ms`)),
        Math.min(attemptTimeoutMs, remaining),
      )
      try {
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path, args, format: "json" }),
          signal: controller.signal,
        })
        const body = await response.json().catch(() => ({}))
        if (response.ok && body.status === "success") return body.value
        lastError = new Error(body.errorMessage ?? `HTTP ${response.status}`)
        if (body.status === "error") break
        if (response.status >= 400 && response.status < 500) break
      } catch (error) {
        lastError = controller.signal.aborted ? controller.signal.reason : error
      } finally {
        clearTimeout(timer)
      }
      if (attempt < MAX_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, Math.min(500 * attempt, Math.max(deadline - Date.now(), 0))))
    }
    throw lastError ?? new Error("reporting deadline exceeded")
  }

  return {
    enabled: true,
    async recordStepResult({ stepIndex, passed, output }) {
      try {
        const value = await mutation("steps:recordStepResult", {
          sessionId,
          sessionToken,
          stepIndex,
          passed,
          output,
        })
        return { reported: true, value }
      } catch (error) {
        logger.error?.(`[reporter] recordStepResult failed: ${error.message}`)
        return { reported: false, error: error.message }
      }
    },
  }
}
