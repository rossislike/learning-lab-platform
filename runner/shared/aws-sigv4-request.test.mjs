import assert from "node:assert/strict"
import test from "node:test"
import { createMetricsPublisher, putMetricData, signRequest } from "./aws-sigv4-request.mjs"

// aws-sig-v4-test-suite "get-vanilla" (service "service", 2015-08-30): only
// host and x-amz-date are signed there, so the content hash header is off.
const suite = {
  region: "us-east-1",
  service: "service",
  now: new Date("2015-08-30T12:36:00Z"),
  credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" },
}

test("signRequest reproduces the SigV4 test-suite get-vanilla signature", () => {
  const headers = signRequest({ method: "GET", url: "https://example.amazonaws.com/", includeContentSha256: false, ...suite })
  assert.equal(headers["x-amz-date"], "20150830T123600Z")
  assert.equal(
    headers.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
  )
})

test("signRequest with query parameters (get-vanilla-query-order-key-case) and a session token", () => {
  const headers = signRequest({ method: "GET", url: "https://example.amazonaws.com/?Param2=value2&Param1=value1", includeContentSha256: false, ...suite })
  assert.equal(
    headers.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500",
  )
  const withToken = signRequest({ method: "GET", url: "https://example.amazonaws.com/", ...suite, credentials: { ...suite.credentials, sessionToken: "tok" } })
  assert.match(withToken.authorization, /SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token/)
  assert.equal(withToken["x-amz-security-token"], "tok")
})

test("putMetricData posts a signed Query API request and surfaces failures", async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return { ok: true }
  }
  await putMetricData({
    region: "us-east-2",
    namespace: "LearningLab/Dispatcher",
    metrics: [{ name: "Heartbeat", value: 1, dimensions: { Environment: "dev" } }, { name: "ActiveSessions", value: 3, unit: "Count" }],
    credentials: suite.credentials,
    fetchImpl,
    now: suite.now,
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, "https://monitoring.us-east-2.amazonaws.com/")
  const body = new URLSearchParams(calls[0].init.body)
  assert.equal(body.get("Action"), "PutMetricData")
  assert.equal(body.get("Namespace"), "LearningLab/Dispatcher")
  assert.equal(body.get("MetricData.member.1.MetricName"), "Heartbeat")
  assert.equal(body.get("MetricData.member.1.Dimensions.member.1.Name"), "Environment")
  assert.equal(body.get("MetricData.member.2.Value"), "3")
  assert.match(calls[0].init.headers.authorization, /Credential=AKIDEXAMPLE\/20150830\/us-east-2\/monitoring\/aws4_request/)
  assert.equal(calls[0].init.headers["x-amz-content-sha256"].length, 64)

  await assert.rejects(
    putMetricData({ region: "us-east-2", namespace: "n", metrics: [{ name: "x", value: 1 }], credentials: suite.credentials, fetchImpl: async () => ({ ok: false, status: 403, text: async () => "<Error>AccessDenied</Error>" }) }),
    /HTTP 403 .*AccessDenied/,
  )
})

test("metrics publisher batches counters and gauges, throttles, and never throws", async () => {
  let clock = 1_000_000
  const puts = []
  const publisher = createMetricsPublisher({
    region: "us-east-2",
    namespace: "LearningLab/Dispatcher",
    dimensions: { Environment: "dev" },
    getCredentials: async () => suite.credentials,
    intervalMs: 60_000,
    now: () => clock,
    logger: { warn() {} },
    put: async (input) => {
      puts.push(input)
      if (input.metrics.some((m) => m.name === "Boom")) throw new Error("boom")
    },
  })
  assert.equal(await publisher.flush(), false, "nothing recorded yet")
  publisher.count("LaunchFailures")
  publisher.count("LaunchFailures", 2)
  publisher.gauge("ActiveSessions", 4)
  assert.equal(await publisher.flush(), true)
  assert.deepEqual(puts[0].metrics.map((m) => [m.name, m.value, m.dimensions.Environment]), [["LaunchFailures", 3, "dev"], ["ActiveSessions", 4, "dev"]])
  publisher.count("Heartbeat")
  assert.equal(await publisher.flush(), false, "throttled within the interval")
  clock += 61_000
  assert.equal(await publisher.flush(), true)
  assert.deepEqual(puts[1].metrics.map((m) => [m.name, m.value]), [["Heartbeat", 1], ["ActiveSessions", 4]], "counters reset, gauges persist")
  clock += 61_000
  publisher.count("Boom")
  assert.equal(await publisher.flush(), false, "a failed put is swallowed")
  assert.equal(await publisher.flush({ force: true }), false, "and backs off for an interval")
})
