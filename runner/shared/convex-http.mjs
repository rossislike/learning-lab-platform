// Convex HTTP API client for platform services (dispatcher, gateway).
// Dependency-free so the platform image needs no npm install. The runner
// secret is added to every call; application errors surface as thrown
// ConvexError with the first line of the server's message, with any
// occurrence of the runner secret redacted (messages end up in logs).

export class ConvexError extends Error {
  constructor(message, { path, status } = {}) {
    super(message)
    this.name = "ConvexError"
    this.path = path
    this.status = status
  }
}

export function createConvexHttp({ convexUrl, runnerSecret, fetchImpl = globalThis.fetch, timeoutMs = 10_000 }) {
  if (!convexUrl) throw new Error("CONVEX_URL is required")
  if (!runnerSecret) throw new Error("RUNNER_SHARED_SECRET is required")
  const base = convexUrl.replace(/\/+$/, "")

  function sanitize(message) {
    const firstLine = String(message ?? "").split(/\r?\n/)[0].trim() || "unknown error"
    return firstLine.split(runnerSecret).join("[redacted]")
  }

  async function call(kind, path, args) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(`${base}/api/${kind}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, args: { ...args, runnerSecret }, format: "json" }),
        signal: controller.signal,
      })
      const body = await response.json().catch(() => ({}))
      if (response.ok && body.status === "success") return body.value
      throw new ConvexError(sanitize(body.errorMessage ?? `HTTP ${response.status}`), { path, status: response.status })
    } catch (error) {
      if (error instanceof ConvexError) throw error
      throw new ConvexError(error.name === "AbortError" ? `timeout after ${timeoutMs} ms` : sanitize(error.message), { path })
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    query: (path, args = {}) => call("query", path, args),
    mutation: (path, args = {}) => call("mutation", path, args),
  }
}
