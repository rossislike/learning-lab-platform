// Dependency-free AWS Signature Version 4 for the one thing the dispatcher
// needs in dev: presigned S3 GET URLs for scenario bundles (ADR 0007), and
// the credentials to sign them with (EKS Pod Identity, or static env for
// tests and local runs).

import { createHash, createHmac } from "node:crypto"
import { readFile } from "node:fs/promises"

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex")
}

function hmac(key, value, encoding) {
  return createHmac("sha256", key).update(value).digest(encoding)
}

/** RFC 3986 encoding as SigV4 expects it (encode everything but unreserved). */
export function sigv4Encode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

function amzDate(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")
}

function signingKey(secretAccessKey, dateStamp, region, service) {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, service)
  return hmac(kService, "aws4_request")
}

const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/
const KEY_PATH = /^[A-Za-z0-9!_.*'()/-]+$/

/**
 * Presign an S3 GET (virtual-hosted style, UNSIGNED-PAYLOAD).
 *
 * @param {{
 *   bucket: string, region: string, key: string, expiresSeconds?: number, now?: Date,
 *   credentials: { accessKeyId: string, secretAccessKey: string, sessionToken?: string },
 *   host?: string,
 * }} input
 * @returns {string} https URL
 */
export function presignS3GetObject({ bucket, region, key, expiresSeconds = 600, now = new Date(), credentials, host }) {
  if (!BUCKET_NAME.test(bucket) || bucket.includes("..")) throw new Error(`invalid S3 bucket name ${JSON.stringify(bucket)}`)
  if (!KEY_PATH.test(key) || key.includes("..") || key.startsWith("/")) throw new Error(`invalid S3 key ${JSON.stringify(key)}`)
  if (!Number.isInteger(expiresSeconds) || expiresSeconds < 1 || expiresSeconds > 604800) throw new Error("expiresSeconds must be 1..604800")
  if (!credentials?.accessKeyId || !credentials?.secretAccessKey) throw new Error("AWS credentials are required")

  const service = "s3"
  const endpointHost = host ?? `${bucket}.s3.${region}.amazonaws.com`
  const timestamp = amzDate(now)
  const dateStamp = timestamp.slice(0, 8)
  const scope = `${dateStamp}/${region}/${service}/aws4_request`
  const canonicalUri = `/${key.split("/").map(sigv4Encode).join("/")}`

  const query = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${credentials.accessKeyId}/${scope}`,
    "X-Amz-Date": timestamp,
    "X-Amz-Expires": String(expiresSeconds),
    ...(credentials.sessionToken ? { "X-Amz-Security-Token": credentials.sessionToken } : {}),
    "X-Amz-SignedHeaders": "host",
  }
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((name) => `${sigv4Encode(name)}=${sigv4Encode(query[name])}`)
    .join("&")
  const canonicalRequest = ["GET", canonicalUri, canonicalQuery, `host:${endpointHost}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n")
  const stringToSign = ["AWS4-HMAC-SHA256", timestamp, scope, sha256Hex(canonicalRequest)].join("\n")
  const signature = hmac(signingKey(credentials.secretAccessKey, dateStamp, region, service), stringToSign, "hex")
  return `https://${endpointHost}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`
}

/**
 * Resolve credentials the way the SDK's default chain would for our two
 * cases, in this order:
 *   1. static env (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY [/ AWS_SESSION_TOKEN])
 *   2. container credentials (EKS Pod Identity injects
 *      AWS_CONTAINER_CREDENTIALS_FULL_URI + AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE)
 * Results are cached until `refreshMarginMs` before they expire. A URL
 * presigned with temporary credentials stops working when they expire, so
 * the margin must cover the presign lifetime plus slack (default 20 min;
 * the dispatcher passes its 15-minute presign lifetime + 5 min).
 */
export function createCredentialProvider({
  env = process.env,
  fetchImpl = fetch,
  readFileImpl = readFile,
  now = () => Date.now(),
  refreshMarginMs = 20 * 60 * 1000,
} = {}) {
  let cached = null

  async function fromContainer() {
    const uri = env.AWS_CONTAINER_CREDENTIALS_FULL_URI
    if (!uri) return null
    const url = new URL(uri)
    if (!(url.protocol === "https:" || (url.protocol === "http:" && (url.hostname === "169.254.170.2" || url.hostname === "169.254.170.23" || url.hostname === "localhost" || url.hostname === "127.0.0.1")))) {
      throw new Error("AWS_CONTAINER_CREDENTIALS_FULL_URI must be https or a loopback/link-local http address")
    }
    const headers = {}
    if (env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE) headers.authorization = (await readFileImpl(env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE, "utf8")).trim()
    else if (env.AWS_CONTAINER_AUTHORIZATION_TOKEN) headers.authorization = env.AWS_CONTAINER_AUTHORIZATION_TOKEN
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(5000) })
    if (!response.ok) throw new Error(`container credentials endpoint returned ${response.status}`)
    const body = await response.json()
    if (!body?.AccessKeyId || !body?.SecretAccessKey) throw new Error("container credentials endpoint returned no credentials")
    return {
      accessKeyId: body.AccessKeyId,
      secretAccessKey: body.SecretAccessKey,
      sessionToken: body.Token,
      expiresAt: body.Expiration ? Date.parse(body.Expiration) : now() + 60 * 60 * 1000,
    }
  }

  return async function getCredentials() {
    if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
      return { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, sessionToken: env.AWS_SESSION_TOKEN }
    }
    if (cached && cached.expiresAt - now() > refreshMarginMs) return cached
    const fresh = await fromContainer()
    if (!fresh) throw new Error("no AWS credentials: set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY or run with EKS Pod Identity")
    cached = fresh
    return cached
  }
}
