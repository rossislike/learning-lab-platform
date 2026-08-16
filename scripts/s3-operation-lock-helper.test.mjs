import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { Readable } from "node:stream"
import { fileURLToPath } from "node:url"
import test from "node:test"

import { S3Client } from "@aws-sdk/client-s3"

import { executeS3OperationLock } from "./s3-operation-lock-helper.mjs"

const account = "442359104502"
const etag = "\"0123456789abcdef0123456789abcdef\""
const payload = {
  schemaVersion: 1,
  region: "us-west-2",
  bucket: "state-bucket",
  key: "operations/hosted.lock",
  expectedBucketOwner: account,
  kmsKeyId: `arn:aws:kms:us-west-2:${account}:key/11111111-2222-3333-4444-555555555555`,
  owner: "owner-11111111-2222-3333-4444-555555555555",
}

function sdkClient(requests, owner = payload.owner) {
  return new S3Client({
    region: payload.region,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    forcePathStyle: true,
    requestHandler: {
      async handle(request) {
        requests.push(request)
        const headers = request.method === "PUT"
          ? { etag }
          : request.method === "HEAD"
            ? { etag, "x-amz-meta-hosted-operation-owner": owner }
            : {}
        return {
          response: {
            statusCode: request.method === "DELETE" ? 204 : 200,
            headers,
            body: Readable.from([]),
          },
        }
      },
    },
  })
}

test("the installed S3 SDK serializes atomic acquisition and conditional release headers", async () => {
  const requests = []
  const client = sdkClient(requests)

  assert.deepEqual(await executeS3OperationLock("acquire", payload, { client }), { ok: true, etag })
  assert.deepEqual(
    await executeS3OperationLock("verify", { ...payload, etag }, { client }),
    { ok: true, owned: true },
  )
  assert.deepEqual(
    await executeS3OperationLock("release", { ...payload, etag }, { client }),
    { ok: true, released: true },
  )

  assert.deepEqual(requests.map(({ method }) => method), ["PUT", "HEAD", "HEAD", "DELETE"])
  const put = requests[0]
  assert.equal(put.headers["if-none-match"], "*")
  assert.equal(put.headers["x-amz-meta-hosted-operation-owner"], payload.owner)
  assert.equal(put.headers["x-amz-server-side-encryption"], "aws:kms")
  assert.equal(put.headers["x-amz-server-side-encryption-aws-kms-key-id"], payload.kmsKeyId)
  assert.equal(put.headers["x-amz-expected-bucket-owner"], account)

  const remove = requests[3]
  assert.equal(remove.headers["if-match"], etag)
  assert.equal(remove.headers["x-amz-expected-bucket-owner"], account)
})

test("release does not issue a delete when owner metadata changed", async () => {
  const requests = []
  const client = sdkClient(requests, "another-owner")
  assert.deepEqual(
    await executeS3OperationLock("release", { ...payload, etag }, { client }),
    { ok: true, owned: false, released: false },
  )
  assert.deepEqual(requests.map(({ method }) => method), ["HEAD"])
})

test("release remains owned when the lock changes between head and conditional delete", async () => {
  const requests = []
  const client = new S3Client({
    region: payload.region,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    forcePathStyle: true,
    requestHandler: {
      async handle(request) {
        requests.push(request)
        if (request.method === "HEAD") {
          return {
            response: {
              statusCode: 200,
              headers: { etag, "x-amz-meta-hosted-operation-owner": payload.owner },
              body: Readable.from([]),
            },
          }
        }
        return {
          response: {
            statusCode: 412,
            headers: { "content-type": "application/xml" },
            body: Readable.from(["<Error><Code>PreconditionFailed</Code><Message>lock changed</Message></Error>"]),
          },
        }
      },
    },
  })

  assert.deepEqual(
    await executeS3OperationLock("release", { ...payload, etag }, { client }),
    { ok: true, released: false },
  )
  assert.deepEqual(requests.map(({ method }) => method), ["HEAD", "DELETE"])
  assert.equal(requests[1].headers["if-match"], etag)
})

test("the synchronous helper process loads the SDK and rejects invalid input without AWS access", () => {
  const helperPath = fileURLToPath(new URL("./s3-operation-lock-helper.mjs", import.meta.url))
  const result = spawnSync(process.execPath, [helperPath, "acquire"], {
    encoding: "utf8",
    input: "{}\n",
  })
  assert.equal(result.status, 1)
  assert.deepEqual(JSON.parse(result.stdout), { ok: false, reason: "invalid-request" })
})
