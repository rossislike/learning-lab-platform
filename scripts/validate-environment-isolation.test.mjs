import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import test from "node:test"

import { validateIsolationRegistry } from "./validate-environment-isolation.mjs"
import { runHostedCommand } from "./run-hosted-command.mjs"

function registry(overrides = {}) {
  return {
    schemaVersion: 1,
    temporaryException: {
      approved: false,
      allowedIdentitySharing: [],
      approver: null,
      productionLearnerTrafficBlocked: true,
      deadline: "2026-08-12",
      migrationStatus: "blocked",
      owner: "platform owner",
      reason: "Resources are pending.",
    },
    environments: {
      development: {
        awsAccountId: null,
        clerkApplicationId: "app_development",
        convexDeployment: "dev:development-deployment",
      },
      staging: {
        awsAccountId: "111111111111",
        clerkApplicationId: "app_staging",
        convexDeployment: "prod:staging-deployment",
      },
      production: {
        awsAccountId: "222222222222",
        clerkApplicationId: "app_production",
        convexDeployment: "prod:production-deployment",
      },
      ...overrides,
    },
  }
}

test("accepts distinct staging and production identities", () => {
  const result = validateIsolationRegistry(registry(), {
    today: new Date("2026-07-12T00:00:00Z"),
  })

  assert.deepEqual(result, { blockers: [], errors: [], ready: true })
})

test("accepts approved temporary AWS account sharing", () => {
  const value = registry()
  value.temporaryException.approved = true
  value.temporaryException.approver = "repository owner"
  value.temporaryException.allowedIdentitySharing = [{
    field: "awsAccountId",
    environments: ["staging", "production"],
  }]
  value.environments.staging.awsAccountId = value.environments.production.awsAccountId

  assert.equal(validateIsolationRegistry(value).ready, true)
})

test("blocks readiness while an environment identity is missing", () => {
  const value = registry()
  value.environments.staging.awsAccountId = null

  const result = validateIsolationRegistry(value, {
    today: new Date("2026-07-12T00:00:00Z"),
  })

  assert.equal(result.ready, false)
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.blockers, ["staging.awsAccountId is not configured"])
})

test("rejects shared staging and production identities", () => {
  const value = registry()
  value.environments.staging.clerkApplicationId = "app_production"

  const result = validateIsolationRegistry(value, {
    today: new Date("2026-07-12T00:00:00Z"),
  })

  assert.equal(result.ready, false)
  assert.deepEqual(result.errors, ["production.clerkApplicationId duplicates staging.clerkApplicationId"])
})

test("rejects a sharing rule scoped to development", () => {
  const value = registry()
  value.temporaryException.approved = true
  value.temporaryException.approver = "repository owner"
  value.temporaryException.allowedIdentitySharing = [{ field: "awsAccountId", environments: ["development", "staging"] }]
  value.environments.development.awsAccountId = value.environments.staging.awsAccountId
  assert.match(validateIsolationRegistry(value).errors.join("\n"), /exactly the staging and production environments/)
})

test("rejects a three-environment sharing rule", () => {
  const value = registry()
  value.temporaryException.allowedIdentitySharing = [{
    field: "awsAccountId",
    environments: ["development", "staging", "production"],
  }]
  assert.match(validateIsolationRegistry(value).errors.join("\n"), /exactly the staging and production environments/)
})

test("rejects sharing without approval", () => {
  const value = registry()
  value.temporaryException.allowedIdentitySharing = [{ field: "awsAccountId", environments: ["staging", "production"] }]
  value.environments.staging.awsAccountId = value.environments.production.awsAccountId
  const errors = validateIsolationRegistry(value).errors.join("\n")
  assert.match(errors, /duplicates staging/)
  assert.match(errors, /must be empty when unapproved/)
})

test("rejects an impossible calendar deadline", () => {
  const value = registry()
  value.temporaryException.deadline = "2026-02-30"
  assert.match(validateIsolationRegistry(value).errors.join("\n"), /real YYYY-MM-DD/)
})

test("rejects malformed identities and duplicate development identity", () => {
  const value = registry()
  value.environments.staging.awsAccountId = "123"
  value.environments.production.convexDeployment = "dev:development-deployment"
  const errors = validateIsolationRegistry(value).errors.join("\n")
  assert.match(errors, /staging.awsAccountId has an invalid type or format/)
  assert.match(errors, /production.convexDeployment duplicates development.convexDeployment/)
})

test("requires governance metadata", () => {
  const value = registry()
  value.temporaryException.owner = ""
  value.temporaryException.approver = "someone"
  value.temporaryException.migrationStatus = "later"
  const errors = validateIsolationRegistry(value).errors.join("\n")
  assert.match(errors, /owner must be a nonempty string/)
  assert.match(errors, /approver must be null when unapproved/)
  assert.match(errors, /migrationStatus/)
})

test("hosted command rejects unknown arguments", async () => {
  assert.equal(await runHostedCommand(["terraform", "plan", "staging", "-destroy"]), 2)
})

test("validator CLI exits two for an unknown argument", () => {
  const result = spawnSync(process.execPath, ["scripts/validate-environment-isolation.mjs", "--unknown"], {
    encoding: "utf8",
  })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /usage:/)
})

test("hosted command blocks before execution when registry is incomplete", async () => {
  const value = registry()
  value.environments.staging.awsAccountId = null
  let executed = false
  const status = await runHostedCommand(["terraform", "plan", "staging"], {
    loadRegistry: async () => value,
    execute: () => { executed = true; return 0 },
  })
  assert.equal(status, 1)
  assert.equal(executed, false)
})

test("hosted Terraform command checks AWS identity and forwards explicit arguments", async () => {
  let invocation
  const status = await runHostedCommand(["terraform", "plan", "staging", "--", "-var-file=staging.tfvars"], {
    loadRegistry: async () => registry(),
    awsAccountId: "111111111111",
    execute: (command, args) => { invocation = { command, args }; return 0 },
  })
  assert.equal(status, 0)
  assert.deepEqual(invocation, {
    command: "terraform",
    args: ["-chdir=infra/aws/environments/staging", "plan", "-var=expected_aws_account_id=111111111111", "-var-file=staging.tfvars"],
  })
})

test("rejects an expired exception while blockers remain", () => {
  const value = registry()
  value.temporaryException.approved = true
  value.temporaryException.approver = "repository owner"
  value.temporaryException.allowedIdentitySharing = [{ field: "awsAccountId", environments: ["staging", "production"] }]
  value.environments.staging.awsAccountId = value.environments.production.awsAccountId
  value.environments.production.convexDeployment = null

  const result = validateIsolationRegistry(value, {
    today: new Date("2026-08-13T00:00:00Z"),
  })

  assert.equal(result.ready, false)
  assert.deepEqual(result.errors, [
    "temporary environment-isolation exception has expired",
  ])
})

test("rejects expired sharing even when all identities are configured", () => {
  const value = registry()
  value.temporaryException.approved = true
  value.temporaryException.approver = "repository owner"
  value.temporaryException.allowedIdentitySharing = [{ field: "awsAccountId", environments: ["staging", "production"] }]
  value.environments.staging.awsAccountId = value.environments.production.awsAccountId
  const result = validateIsolationRegistry(value, { today: new Date("2026-08-13T00:00:00Z") })
  assert.match(result.errors.join("\n"), /has expired/)
})
