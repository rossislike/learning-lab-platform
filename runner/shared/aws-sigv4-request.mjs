// SigV4 for signed API requests (as opposed to presigned URLs, see
// aws-sigv4.mjs): the dispatcher publishes CloudWatch metrics with it.
// Dependency-free, header-based signing per the SigV4 specification.

import { createHash, createHmac } from "node:crypto"
import { sigv4Encode } from "./aws-sigv4.mjs"

const sha256Hex = (value) => createHash("sha256").update(value).digest("hex")
const hmac = (key, value, encoding) => createHmac("sha256", key).update(value).digest(encoding)
const amzDate = (date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")

function canonicalQuery(searchParams) {
  const pairs = []
  for (const [name, value] of searchParams) pairs.push([sigv4Encode(name), sigv4Encode(value)])
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
  return pairs.map(([name, value]) => `${name}=${value}`).join("&")
}

/**
 * Returns the headers (including Authorization) for a signed request.
 * `headers` must include `host` or it is derived from the URL. Body is a
 * string or Buffer (empty for GET).
 */
export function signRequest({ method, url, headers = {}, body = "", region, service, credentials, now = new Date(), includeContentSha256 = true }) {
  if (!credentials?.accessKeyId || !credentials?.secretAccessKey) throw new Error("AWS credentials are required")
  const target = new URL(url)
  const timestamp = amzDate(now)
  const dateStamp = timestamp.slice(0, 8)
  const scope = `${dateStamp}/${region}/${service}/aws4_request`
  const payloadHash = sha256Hex(body)

  const signed = { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])) }
  signed.host ??= target.host
  signed["x-amz-date"] = timestamp
  if (includeContentSha256) signed["x-amz-content-sha256"] = payloadHash
  if (credentials.sessionToken) signed["x-amz-security-token"] = credentials.sessionToken

  const signedNames = Object.keys(signed).sort()
  const canonicalHeaders = signedNames.map((name) => `${name}:${signed[name].replace(/\s+/g, " ")}\n`).join("")
  // URL.pathname is already percent-encoded once, which is what every
  // service except S3 expects; callers here only sign "/" (CloudWatch), so
  // no second encoding pass is applied. Do not reuse this for S3 object keys
  // with reserved characters without revisiting it.
  const canonicalPath = target.pathname === "" ? "/" : target.pathname
  const canonicalRequest = [method.toUpperCase(), canonicalPath, canonicalQuery(target.searchParams), canonicalHeaders, signedNames.join(";"), payloadHash].join("\n")
  const stringToSign = ["AWS4-HMAC-SHA256", timestamp, scope, sha256Hex(canonicalRequest)].join("\n")
  const kDate = hmac(`AWS4${credentials.secretAccessKey}`, dateStamp)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, service)
  const kSigning = hmac(kService, "aws4_request")
  const signature = hmac(kSigning, stringToSign, "hex")
  return {
    ...signed,
    authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedNames.join(";")}, Signature=${signature}`,
  }
}

/**
 * CloudWatch PutMetricData (Query API, form-encoded). `metrics` is
 * [{ name, value, unit?, dimensions?: {Name: Value} }]. Returns nothing on
 * success, throws with the response body otherwise.
 */
export async function putMetricData({ region, namespace, metrics, credentials, fetchImpl = fetch, now = new Date(), endpoint }) {
  if (metrics.length === 0) return
  if (metrics.length > 1000) throw new Error("PutMetricData accepts at most 1000 metrics per call")
  const params = new URLSearchParams({ Action: "PutMetricData", Version: "2010-08-01", Namespace: namespace })
  metrics.forEach((metric, index) => {
    const prefix = `MetricData.member.${index + 1}`
    params.set(`${prefix}.MetricName`, metric.name)
    params.set(`${prefix}.Value`, String(metric.value))
    params.set(`${prefix}.Unit`, metric.unit ?? "Count")
    params.set(`${prefix}.Timestamp`, (metric.timestamp ?? now).toISOString())
    params.set(`${prefix}.StorageResolution`, "60")
    Object.entries(metric.dimensions ?? {}).forEach(([name, value], dimensionIndex) => {
      params.set(`${prefix}.Dimensions.member.${dimensionIndex + 1}.Name`, name)
      params.set(`${prefix}.Dimensions.member.${dimensionIndex + 1}.Value`, String(value))
    })
  })
  const body = params.toString()
  const url = endpoint ?? `https://monitoring.${region}.amazonaws.com/`
  const headers = signRequest({
    method: "POST",
    url,
    headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
    body,
    region,
    service: "monitoring",
    credentials,
    now,
  })
  // `host` is signed but not sent explicitly: fetch (undici) sets it from the
  // URL and may reject a caller-supplied Host header.
  const sendHeaders = { ...headers }
  delete sendHeaders.host
  const response = await fetchImpl(url, { method: "POST", headers: sendHeaders, body, signal: AbortSignal.timeout(10_000) })
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(`PutMetricData failed: HTTP ${response.status} ${text.slice(0, 300)}`)
  }
}

/**
 * Accumulates counters/gauges and publishes them at most every `intervalMs`.
 * Failures are logged, never thrown: metrics must not take the dispatcher down.
 */
export function createMetricsPublisher({ region, namespace, dimensions = {}, getCredentials, intervalMs = 60_000, logger = console, now = () => Date.now(), put = putMetricData }) {
  const counters = new Map()
  const gauges = new Map()
  let lastFlush = 0
  let flushing = false
  return {
    count(name, value = 1) {
      counters.set(name, (counters.get(name) ?? 0) + value)
    },
    gauge(name, value) {
      gauges.set(name, value)
    },
    async flush({ force = false } = {}) {
      if (flushing) return false
      if (!force && now() - lastFlush < intervalMs) return false
      flushing = true
      try {
        const metrics = [
          ...[...counters].map(([name, value]) => ({ name, value, dimensions })),
          ...[...gauges].map(([name, value]) => ({ name, value, dimensions })),
        ]
        if (metrics.length === 0) return false
        await put({ region, namespace, metrics, credentials: await getCredentials(), now: new Date(now()) })
        counters.clear()
        lastFlush = now()
        return true
      } catch (error) {
        logger.warn?.(`[metrics] ${error.message ?? error}`)
        lastFlush = now() // back off a full interval rather than retrying every tick
        return false
      } finally {
        flushing = false
      }
    },
  }
}
