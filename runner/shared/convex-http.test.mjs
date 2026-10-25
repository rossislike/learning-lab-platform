import assert from "node:assert/strict"
import test from "node:test"
import { ConvexError, createConvexHttp } from "./convex-http.mjs"

const SECRET = "super-secret-runner-value"

function fakeFetch(handler) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ url, body, signal: init.signal })
    return handler(body, init)
  }
  return { fetchImpl, calls }
}

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

test("successful calls add the runner secret and return the value", async () => {
  const { fetchImpl, calls } = fakeFetch(() => response(200, { status: "success", value: { hello: 1 } }))
  const convex = createConvexHttp({ convexUrl: "https://x.convex.cloud/", runnerSecret: SECRET, fetchImpl })
  assert.deepEqual(await convex.mutation("sessions:markRunning", { sessionId: "s1" }), { hello: 1 })
  assert.equal(calls[0].url, "https://x.convex.cloud/api/mutation")
  assert.deepEqual(calls[0].body, { path: "sessions:markRunning", args: { sessionId: "s1", runnerSecret: SECRET }, format: "json" })
  await convex.query("sessions:listForDispatcher")
  assert.equal(calls[1].url, "https://x.convex.cloud/api/query")
})

test("errorMessage becomes a ConvexError: first line only, secret redacted", async () => {
  const { fetchImpl } = fakeFetch(() =>
    response(400, {
      status: "error",
      errorMessage: `Uncaught Error: Runner authorization failed for ${SECRET}\n    at handler (../convex/access.ts:30:5)\n    args: {"runnerSecret":"${SECRET}"}`,
    }),
  )
  const convex = createConvexHttp({ convexUrl: "https://x.convex.cloud", runnerSecret: SECRET, fetchImpl })
  await assert.rejects(convex.mutation("runners:heartbeat", {}), (error) => {
    assert.ok(error instanceof ConvexError)
    assert.equal(error.message, "Uncaught Error: Runner authorization failed for [redacted]")
    assert.equal(error.status, 400)
    assert.equal(error.path, "runners:heartbeat")
    assert.ok(!error.message.includes(SECRET))
    assert.ok(!error.message.includes("\n"))
    return true
  })
})

test("5xx without a body surfaces the HTTP status", async () => {
  const { fetchImpl } = fakeFetch(() => ({ ok: false, status: 503, json: async () => { throw new Error("not json") } }))
  const convex = createConvexHttp({ convexUrl: "https://x.convex.cloud", runnerSecret: SECRET, fetchImpl })
  await assert.rejects(convex.query("sessions:listForDispatcher"), { name: "ConvexError", message: "HTTP 503", status: 503 })
})

test("a 200 whose status is not success is still an error", async () => {
  const { fetchImpl } = fakeFetch(() => response(200, { status: "error", errorMessage: "Session not found" }))
  const convex = createConvexHttp({ convexUrl: "https://x.convex.cloud", runnerSecret: SECRET, fetchImpl })
  await assert.rejects(convex.query("x:y"), { message: "Session not found", status: 200 })
})

test("timeouts abort the request and report the timeout", async () => {
  const { fetchImpl } = fakeFetch(
    (_body, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const error = new Error("aborted")
          error.name = "AbortError"
          reject(error)
        })
      }),
  )
  const convex = createConvexHttp({ convexUrl: "https://x.convex.cloud", runnerSecret: SECRET, fetchImpl, timeoutMs: 20 })
  await assert.rejects(convex.query("x:y"), { name: "ConvexError", message: "timeout after 20 ms", status: undefined })
})

test("network errors are sanitized too", async () => {
  const { fetchImpl } = fakeFetch(() => {
    throw new Error(`connect ECONNREFUSED ${SECRET}\nsecond line`)
  })
  const convex = createConvexHttp({ convexUrl: "https://x.convex.cloud", runnerSecret: SECRET, fetchImpl })
  await assert.rejects(convex.query("x:y"), { message: "connect ECONNREFUSED [redacted]" })
})

test("configuration is required", () => {
  assert.throws(() => createConvexHttp({ convexUrl: "", runnerSecret: SECRET }), /CONVEX_URL/)
  assert.throws(() => createConvexHttp({ convexUrl: "https://x", runnerSecret: "" }), /RUNNER_SHARED_SECRET/)
})
