import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const registryPath = "config/aws-terraform-backends.json"
const operationLockHelperPath = fileURLToPath(new URL("./s3-operation-lock-helper.mjs", import.meta.url))
const rootNames = new Set(["accountSecurity", "staging", "production"])

function resultStatus(result) {
  return typeof result === "number" ? result : result?.status ?? 1
}

function resultText(result) {
  if (resultStatus(result) !== 0 || typeof result?.stdout !== "string") return null
  return result.stdout.trim()
}

function parseJson(text) {
  try { return JSON.parse(text) } catch { return null }
}

function validRegistry(value) {
  if (
    value?.schemaVersion !== 1 ||
    !/^\d{12}$/.test(value.accountId ?? "") ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value.bucket ?? "") ||
    !/^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/.test(value.region ?? "") ||
    typeof value.kmsKeyId !== "string" || !value.kmsKeyId ||
    typeof value.operationLockKey !== "string" || !value.operationLockKey
  ) return false
  const kmsPattern = new RegExp(`^arn:aws:kms:${value.region}:${value.accountId}:key/[0-9a-f-]{36}$`)
  if (!kmsPattern.test(value.kmsKeyId)) return false
  if (!/^[A-Za-z0-9/_.-]+\.lock$/.test(value.operationLockKey)) return false
  if (Object.keys(value.roots ?? {}).length !== rootNames.size) return false
  const roots = [...rootNames].map((name) => value.roots?.[name])
  if (!roots.every((root) => {
    const safeDirectory = typeof root?.directory === "string" && /^infra\/aws\/[A-Za-z0-9/_-]+$/.test(root.directory)
    const safeKey = typeof root?.key === "string" && /^[A-Za-z0-9/_.-]+\.tfstate$/.test(root.key)
    return safeDirectory && safeKey
  })) return false
  if (new Set(roots.map((root) => root.directory)).size !== roots.length) return false
  if (new Set(roots.map((root) => root.key)).size !== roots.length) return false
  return true
}

export function loadAwsTerraformBackendRegistry(rootPath = process.cwd(), fs = { readFileSync }) {
  const value = parseJson(fs.readFileSync(join(rootPath, registryPath), "utf8"))
  if (!validRegistry(value)) throw new Error("canonical AWS Terraform backend registry is invalid")
  return value
}

function sameStringArray(value, expected) {
  return Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index])
}

export function validateCanonicalTerraformRoot(name, options = {}) {
  if (!rootNames.has(name)) return { ok: false, error: `unknown Terraform root ${name}` }
  const rootPath = options.rootPath ?? process.cwd()
  const fs = options.fs ?? { existsSync, readFileSync }
  const run = options.execute
  const registry = options.registry ?? loadAwsTerraformBackendRegistry(rootPath, fs)
  const root = registry.roots[name]
  const metadataPath = join(rootPath, root.directory, ".terraform/terraform.tfstate")
  if (!fs.existsSync(metadataPath)) return { ok: false, error: `${name} Terraform backend is not initialized` }
  const metadata = parseJson(fs.readFileSync(metadataPath, "utf8"))
  const backend = metadata?.backend
  const config = backend?.config
  if (
    backend?.type !== "s3" ||
    config?.bucket !== registry.bucket ||
    config?.key !== root.key ||
    config?.region !== registry.region ||
    config?.kms_key_id !== registry.kmsKeyId ||
    config?.encrypt !== true ||
    config?.use_lockfile !== true ||
    !sameStringArray(config?.allowed_account_ids, [registry.accountId]) ||
    ![null, undefined, ""].includes(config?.workspace_key_prefix)
  ) return { ok: false, error: `${name} Terraform backend does not match the canonical S3 identity` }
  if (typeof run !== "function") return { ok: false, error: "Terraform command executor is unavailable" }
  const workspace = resultText(run("terraform", [`-chdir=${root.directory}`, "workspace", "show"], { capture: true }))
  if (workspace !== "default") return { ok: false, error: `${name} Terraform workspace must be default` }
  return { ok: true, registry, root }
}

export function validateCanonicalTerraformRoots(names, options = {}) {
  let registry
  try {
    registry = options.registry ?? loadAwsTerraformBackendRegistry(options.rootPath, options.fs)
  } catch (error) {
    return { ok: false, error: error.message }
  }
  if (options.account && options.account !== registry.accountId) {
    return { ok: false, error: "active account does not match the canonical backend account" }
  }
  for (const name of names) {
    const validation = validateCanonicalTerraformRoot(name, { ...options, registry })
    if (!validation.ok) return validation
  }
  return { ok: true, registry }
}

function lockPayload(registry, owner, etag) {
  return {
    schemaVersion: 1,
    region: registry.region,
    bucket: registry.bucket,
    key: registry.operationLockKey,
    expectedBucketOwner: registry.accountId,
    kmsKeyId: registry.kmsKeyId,
    owner,
    ...(etag === undefined ? {} : { etag }),
  }
}

function invokeOperationLockHelper(action, payload, options = {}) {
  const result = spawnSync(process.execPath, [operationLockHelperPath, action], {
    encoding: "utf8",
    env: options.environment ?? process.env,
    input: `${JSON.stringify(payload)}\n`,
    maxBuffer: 1024 * 1024,
  })
  const response = parseJson(typeof result.stdout === "string" ? result.stdout.trim() : "")
  if (response && typeof response.ok === "boolean") return response
  return { ok: false, reason: "helper-failed" }
}

export function acquireHostedOperationLock(options = {}) {
  const registry = options.registry
  const owner = options.owner ?? randomUUID()
  const invoke = options.invokeLockHelper ?? invokeOperationLockHelper
  if (typeof invoke !== "function" || !validRegistry(registry)) {
    return { ok: false, error: "hosted operation lock configuration is invalid" }
  }
  const response = invoke("acquire", lockPayload(registry, owner), options)
  if (!response?.ok || typeof response.etag !== "string" || !response.etag) {
    return { ok: false, error: "another hosted infrastructure operation is active or the shared lock could not be acquired" }
  }
  return { ok: true, owner, etag: response.etag, registry }
}

export function verifyHostedOperationLock(lock, options = {}) {
  const invoke = options.invokeLockHelper ?? invokeOperationLockHelper
  if (!lock?.ok || typeof invoke !== "function" || !validRegistry(lock.registry)) return false
  const response = invoke("verify", lockPayload(lock.registry, lock.owner, lock.etag), options)
  return response?.ok === true && response.owned === true
}

export function releaseHostedOperationLock(lock, options = {}) {
  const invoke = options.invokeLockHelper ?? invokeOperationLockHelper
  if (!lock?.ok || typeof invoke !== "function" || !validRegistry(lock.registry)) return false
  const response = invoke("release", lockPayload(lock.registry, lock.owner, lock.etag), options)
  return response?.ok === true && response.released === true
}

export const canonicalTerraformRootNames = Object.freeze([...rootNames])
