import assert from "node:assert/strict"
import { test } from "node:test"
import { createCredentialProvider, presignS3GetObject, sigv4Encode } from "./aws-sigv4.mjs"

// Worked example from the S3 developer guide ("Authenticating Requests:
// Using Query Parameters (AWS Signature Version 4)").
const docsExample = {
  bucket: "examplebucket",
  host: "examplebucket.s3.amazonaws.com",
  region: "us-east-1",
  key: "test.txt",
  expiresSeconds: 86400,
  now: new Date("2013-05-24T00:00:00Z"),
  credentials: { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
}

test("presigned GET matches the AWS documentation example", () => {
  const url = new URL(presignS3GetObject(docsExample))
  assert.equal(url.origin + url.pathname, "https://examplebucket.s3.amazonaws.com/test.txt")
  assert.equal(url.searchParams.get("X-Amz-Algorithm"), "AWS4-HMAC-SHA256")
  assert.equal(url.searchParams.get("X-Amz-Credential"), "AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request")
  assert.equal(url.searchParams.get("X-Amz-Date"), "20130524T000000Z")
  assert.equal(url.searchParams.get("X-Amz-Expires"), "86400")
  assert.equal(url.searchParams.get("X-Amz-SignedHeaders"), "host")
  assert.equal(url.searchParams.get("X-Amz-Signature"), "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404")
})

test("virtual-hosted regional endpoint, session token and key encoding", () => {
  const url = new URL(
    presignS3GetObject({
      bucket: "llp-bundles",
      region: "us-east-2",
      key: "scenarios/first-commit/bundles/sha256/abc.tar",
      credentials: { accessKeyId: "AKIA", secretAccessKey: "secret", sessionToken: "tok+en/=" },
    }),
  )
  assert.equal(url.host, "llp-bundles.s3.us-east-2.amazonaws.com")
  assert.equal(url.pathname, "/scenarios/first-commit/bundles/sha256/abc.tar")
  assert.equal(url.searchParams.get("X-Amz-Security-Token"), "tok+en/=")
  assert.equal(url.searchParams.get("X-Amz-Expires"), "600")
  assert.match(url.searchParams.get("X-Amz-Signature"), /^[0-9a-f]{64}$/)
})

test("rejects unsafe buckets, keys and expiries", () => {
  const base = { bucket: "b-ok", region: "us-east-2", key: "k", credentials: { accessKeyId: "a", secretAccessKey: "s" } }
  assert.throws(() => presignS3GetObject({ ...base, bucket: "Bad_Bucket" }), /bucket/)
  assert.throws(() => presignS3GetObject({ ...base, key: "../etc" }), /key/)
  assert.throws(() => presignS3GetObject({ ...base, key: "/abs" }), /key/)
  assert.throws(() => presignS3GetObject({ ...base, key: "a b" }), /key/)
  assert.throws(() => presignS3GetObject({ ...base, expiresSeconds: 0 }), /expiresSeconds/)
  assert.throws(() => presignS3GetObject({ ...base, credentials: {} }), /credentials/)
})

test("sigv4Encode encodes reserved characters the way SigV4 expects", () => {
  assert.equal(sigv4Encode("a b+c/d*e'f(g)!"), "a%20b%2Bc%2Fd%2Ae%27f%28g%29%21")
  assert.equal(sigv4Encode("AKIA/20130524/us-east-1/s3/aws4_request"), "AKIA%2F20130524%2Fus-east-1%2Fs3%2Faws4_request")
})

test("credential provider: static env wins, container creds are cached until near expiry", async () => {
  const fromEnv = createCredentialProvider({ env: { AWS_ACCESS_KEY_ID: "id", AWS_SECRET_ACCESS_KEY: "secret", AWS_SESSION_TOKEN: "t" } })
  assert.deepEqual(await fromEnv(), { accessKeyId: "id", secretAccessKey: "secret", sessionToken: "t" })

  let calls = 0
  let clock = Date.parse("2026-10-27T12:00:00Z")
  const expiration = new Date(clock + 60 * 60 * 1000).toISOString()
  const fetchImpl = async (url, { headers }) => {
    calls += 1
    assert.equal(String(url), "http://169.254.170.23/v1/credentials")
    assert.equal(headers.authorization, "pod-token")
    return { ok: true, json: async () => ({ AccessKeyId: `id${calls}`, SecretAccessKey: "s", Token: "tok", Expiration: expiration }) }
  }
  const provider = createCredentialProvider({
    env: { AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://169.254.170.23/v1/credentials", AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: "/token" },
    fetchImpl,
    readFileImpl: async (path) => (path === "/token" ? "pod-token\n" : ""),
    now: () => clock,
  })
  assert.equal((await provider()).accessKeyId, "id1")
  clock += 39 * 60 * 1000 // 21 min left: outside the default 20-minute window
  assert.equal((await provider()).accessKeyId, "id1")
  clock += 2 * 60 * 1000 // 19 min left: a 15-minute presign could outlive these credentials
  assert.equal((await provider()).accessKeyId, "id2")
  assert.equal(calls, 2)
})

test("credential provider: the refresh margin is configurable", async () => {
  let calls = 0
  let clock = Date.parse("2026-10-27T12:00:00Z")
  const expiration = new Date(clock + 60 * 60 * 1000).toISOString()
  const provider = createCredentialProvider({
    env: { AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://169.254.170.23/v1/credentials", AWS_CONTAINER_AUTHORIZATION_TOKEN: "pod-token" },
    fetchImpl: async () => {
      calls += 1
      return { ok: true, json: async () => ({ AccessKeyId: `id${calls}`, SecretAccessKey: "s", Token: "tok", Expiration: expiration }) }
    },
    now: () => clock,
    refreshMarginMs: 5 * 60 * 1000,
  })
  assert.equal((await provider()).accessKeyId, "id1")
  clock += 54 * 60 * 1000 // 6 min left
  assert.equal((await provider()).accessKeyId, "id1")
  clock += 2 * 60 * 1000 // 4 min left
  assert.equal((await provider()).accessKeyId, "id2")
})

test("credential provider: refuses non-loopback http endpoints and reports a missing chain", async () => {
  const bad = createCredentialProvider({ env: { AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://evil.example/creds" }, fetchImpl: async () => assert.fail("must not fetch") })
  await assert.rejects(bad(), /loopback/)
  const none = createCredentialProvider({ env: {} })
  await assert.rejects(none(), /no AWS credentials/)
})
