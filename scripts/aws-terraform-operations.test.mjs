import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
  acquireHostedOperationLock,
  loadAwsTerraformBackendRegistry,
  releaseHostedOperationLock,
  validateCanonicalTerraformRoot,
  verifyHostedOperationLock,
} from "./aws-terraform-operations.mjs"

const account = "442359104502"

function fixture() {
  const rootPath = mkdtempSync(join(tmpdir(), "aws-terraform-operations-"))
  mkdirSync(join(rootPath, "config"), { recursive: true })
  mkdirSync(join(rootPath, "infra/aws/environments/staging/.terraform"), { recursive: true })
  const registry = {
    schemaVersion: 1,
    accountId: account,
    bucket: "state-bucket",
    region: "us-west-2",
    kmsKeyId: `arn:aws:kms:us-west-2:${account}:key/11111111-2222-3333-4444-555555555555`,
    operationLockKey: "operations/hosted.lock",
    roots: {
      accountSecurity: { directory: "infra/aws/account-security", key: "account.tfstate" },
      staging: { directory: "infra/aws/environments/staging", key: "staging.tfstate" },
      production: { directory: "infra/aws/environments/production", key: "production.tfstate" },
    },
  }
  writeFileSync(join(rootPath, "config/aws-terraform-backends.json"), `${JSON.stringify(registry)}\n`)
  writeFileSync(join(rootPath, "infra/aws/environments/staging/.terraform/terraform.tfstate"), JSON.stringify({
    backend: {
      type: "s3",
      config: {
        bucket: registry.bucket,
        key: registry.roots.staging.key,
        region: registry.region,
        kms_key_id: registry.kmsKeyId,
        encrypt: true,
        use_lockfile: true,
        allowed_account_ids: [account],
        workspace_key_prefix: null,
      },
    },
  }))
  return { rootPath, registry }
}

test("canonical backend validation requires the expected backend and default workspace", () => {
  const { rootPath, registry } = fixture()
  try {
    const valid = validateCanonicalTerraformRoot("staging", {
      rootPath,
      registry,
      execute: () => ({ status: 0, stdout: "default\n" }),
    })
    assert.equal(valid.ok, true)
    const alternate = validateCanonicalTerraformRoot("staging", {
      rootPath,
      registry,
      execute: () => ({ status: 0, stdout: "temporary\n" }),
    })
    assert.equal(alternate.ok, false)
    assert.match(alternate.error, /workspace must be default/)

    const metadataPath = join(rootPath, "infra/aws/environments/staging/.terraform/terraform.tfstate")
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"))
    metadata.backend.config.key = "wrong.tfstate"
    writeFileSync(metadataPath, JSON.stringify(metadata))
    const wrongBackend = validateCanonicalTerraformRoot("staging", {
      rootPath,
      registry,
      execute: () => ({ status: 0, stdout: "default\n" }),
    })
    assert.equal(wrongBackend.ok, false)
    assert.match(wrongBackend.error, /canonical S3 identity/)
  } finally { rmSync(rootPath, { recursive: true }) }
})

test("shared operation lock delegates acquisition, verification, and release to the SDK helper", () => {
  const { rootPath, registry } = fixture()
  const calls = []
  try {
    const environment = { AWS_PROFILE: "default" }
    const invokeLockHelper = (action, payload, options) => {
      calls.push({ action, payload, environment: options.environment })
      if (action === "acquire") return { ok: true, etag: "\"etag\"" }
      if (action === "verify") return { ok: true, owned: true }
      if (action === "release") return { ok: true, released: true }
      return { ok: false }
    }
    const options = { environment, invokeLockHelper }
    const lock = acquireHostedOperationLock({ ...options, registry, owner: "owner" })
    assert.equal(lock.ok, true)
    assert.equal(verifyHostedOperationLock(lock, options), true)
    assert.equal(releaseHostedOperationLock(lock, options), true)
    assert.deepEqual(calls.map(({ action }) => action), ["acquire", "verify", "release"])
    assert.deepEqual(calls[0], {
      action: "acquire",
      environment,
      payload: {
        schemaVersion: 1,
        region: registry.region,
        bucket: registry.bucket,
        key: registry.operationLockKey,
        expectedBucketOwner: registry.accountId,
        kmsKeyId: registry.kmsKeyId,
        owner: "owner",
      },
    })
    assert.equal(calls[2].payload.etag, "\"etag\"")
  } finally { rmSync(rootPath, { recursive: true }) }
})

test("shared operation lock refuses to release ownership that changed", () => {
  const { rootPath, registry } = fixture()
  try {
    const invokeLockHelper = (action) => {
      if (action === "acquire") return { ok: true, etag: "\"etag\"" }
      if (action === "release") return { ok: true, released: false }
      throw new Error("unexpected helper action")
    }
    const lock = acquireHostedOperationLock({ invokeLockHelper, registry, owner: "owner" })
    assert.equal(releaseHostedOperationLock(lock, { invokeLockHelper }), false)
  } finally { rmSync(rootPath, { recursive: true }) }
})

test("shared operation lock rejects a concurrent acquisition", () => {
  const { rootPath, registry } = fixture()
  try {
    const lock = acquireHostedOperationLock({
      registry,
      invokeLockHelper: () => ({ ok: false, reason: "contended" }),
    })
    assert.equal(lock.ok, false)
    assert.match(lock.error, /another hosted infrastructure operation/)
  } finally { rmSync(rootPath, { recursive: true }) }
})

test("checked-in backend registry is valid", () => {
  const registry = loadAwsTerraformBackendRegistry()
  assert.equal(registry.accountId, account)
  assert.equal(Object.keys(registry.roots).length, 3)
  for (const [name, root] of Object.entries(registry.roots)) {
    const exampleName = name === "accountSecurity" ? "account-security" : name
    const examplePath = join(root.directory, `${exampleName}.s3.tfbackend.example`)
    const example = readFileSync(examplePath, "utf8")
    assert.match(example, new RegExp(`bucket\\s+= "${registry.bucket}"`))
    assert.match(example, new RegExp(`key\\s+= "${root.key}"`))
    assert.match(example, new RegExp(`region\\s+= "${registry.region}"`))
    assert.match(example, new RegExp(`kms_key_id\\s+= "${registry.kmsKeyId}"`))
  }
})
