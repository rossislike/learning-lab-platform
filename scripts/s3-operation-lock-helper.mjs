import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const metadataKey = "hosted-operation-owner"
const actions = new Set(["acquire", "verify", "release"])

function validPayload(action, payload) {
  if (
    !actions.has(action) ||
    payload?.schemaVersion !== 1 ||
    !/^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/.test(payload.region ?? "") ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(payload.bucket ?? "") ||
    !/^[A-Za-z0-9/_.-]+\.lock$/.test(payload.key ?? "") ||
    !/^\d{12}$/.test(payload.expectedBucketOwner ?? "") ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(payload.owner ?? "")
  ) return false

  const kmsPattern = new RegExp(`^arn:aws:kms:${payload.region}:${payload.expectedBucketOwner}:key/[0-9a-f-]{36}$`)
  if (!kmsPattern.test(payload.kmsKeyId ?? "")) return false
  if (action === "acquire") return payload.etag === undefined
  return typeof payload.etag === "string" && payload.etag.length > 0 && payload.etag.length <= 256 && !/[\r\n]/.test(payload.etag)
}

function requestBase(payload) {
  return {
    Bucket: payload.bucket,
    Key: payload.key,
    ExpectedBucketOwner: payload.expectedBucketOwner,
  }
}

function errorStatus(error) {
  return error?.$metadata?.httpStatusCode
}

function isMissing(error) {
  return errorStatus(error) === 404 || error?.name === "NotFound" || error?.name === "NoSuchKey"
}

function isPreconditionFailure(error) {
  return errorStatus(error) === 412 || error?.name === "PreconditionFailed"
}

async function headOwnership(client, payload) {
  try {
    const response = await client.send(new HeadObjectCommand(requestBase(payload)))
    return {
      ok: true,
      owned: response.ETag === payload.etag && response.Metadata?.[metadataKey] === payload.owner,
    }
  } catch (error) {
    if (isMissing(error)) return { ok: true, owned: false }
    return { ok: false, reason: "request-failed" }
  }
}

export async function executeS3OperationLock(action, payload, options = {}) {
  if (!validPayload(action, payload)) return { ok: false, reason: "invalid-request" }
  const client = options.client ?? new S3Client({ region: payload.region })

  if (action === "acquire") {
    try {
      const response = await client.send(new PutObjectCommand({
        ...requestBase(payload),
        Body: `${JSON.stringify({ owner: payload.owner })}\n`,
        ContentType: "application/json",
        Metadata: { [metadataKey]: payload.owner },
        ServerSideEncryption: "aws:kms",
        SSEKMSKeyId: payload.kmsKeyId,
        IfNoneMatch: "*",
      }))
      if (typeof response.ETag !== "string" || !response.ETag) {
        return { ok: false, reason: "invalid-response" }
      }
      return { ok: true, etag: response.ETag }
    } catch (error) {
      if (isPreconditionFailure(error)) return { ok: false, reason: "contended" }
      return { ok: false, reason: "request-failed" }
    }
  }

  if (action === "verify") return headOwnership(client, payload)

  const ownership = await headOwnership(client, payload)
  if (!ownership.ok || !ownership.owned) return { ...ownership, released: false }
  try {
    await client.send(new DeleteObjectCommand({
      ...requestBase(payload),
      IfMatch: payload.etag,
    }))
    return { ok: true, released: true }
  } catch (error) {
    if (isMissing(error) || isPreconditionFailure(error)) {
      return { ok: true, released: false }
    }
    return { ok: false, reason: "request-failed", released: false }
  }
}

async function main() {
  let payload
  try {
    payload = JSON.parse(readFileSync(0, "utf8"))
  } catch {
    payload = null
  }
  const result = await executeS3OperationLock(process.argv[2], payload)
  process.stdout.write(`${JSON.stringify(result)}\n`)
  return result.ok ? 0 : 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main()
