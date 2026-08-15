import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import test from "node:test"

import { validateIsolationRegistry } from "./validate-environment-isolation.mjs"
import { runHostedCommand } from "./run-hosted-command.mjs"

const sharedAccountId = "442359104502"
const isolationBoundaries = [
  "terraformState",
  "resourceNames",
  "network",
  "iam",
  "kms",
  "ecr",
  "objectStorage",
  "secrets",
]

function registry(overrides = {}) {
  return {
    schemaVersion: 2,
    awsAccountTopology: {
      mode: "shared",
      sharedAccountId,
      environments: ["staging", "production"],
      isolationBoundaries,
      owner: "platform owner",
      reason: "Hosted environments share one account with environment-scoped resources.",
    },
    productionLearnerTrafficBlocked: false,
    environments: {
      development: {
        awsAccountId: null,
        clerkApplicationId: "app_development",
        convexDeployment: "dev:development-deployment",
      },
      staging: {
        awsAccountId: sharedAccountId,
        clerkApplicationId: "app_staging",
        convexDeployment: "prod:staging-deployment",
      },
      production: {
        awsAccountId: sharedAccountId,
        clerkApplicationId: "app_production",
        convexDeployment: "prod:production-deployment",
      },
      ...overrides,
    },
  }
}

test("accepts shared AWS account with distinct hosted application identities", () => {
  assert.deepEqual(validateIsolationRegistry(registry()), {
    blockers: [],
    errors: [],
    ready: true,
  })
})

test("rejects any topology other than the permanent shared account", () => {
  const value = registry()
  value.awsAccountTopology.mode = "separate"
  value.awsAccountTopology.sharedAccountId = "111111111111"
  value.environments.production.awsAccountId = "222222222222"

  const errors = validateIsolationRegistry(value).errors.join("\n")
  assert.match(errors, /mode must be shared/)
  assert.match(errors, /sharedAccountId must be 442359104502/)
})

test("blocks readiness while an environment identity is missing", () => {
  const value = registry()
  value.environments.staging.clerkApplicationId = null
  value.productionLearnerTrafficBlocked = true

  const result = validateIsolationRegistry(value)
  assert.equal(result.ready, false)
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.blockers, ["staging.clerkApplicationId is not configured"])
})

test("requires production traffic to stay blocked while identities are missing", () => {
  const value = registry()
  value.environments.production.convexDeployment = null

  assert.match(
    validateIsolationRegistry(value).errors.join("\n"),
    /productionLearnerTrafficBlocked must remain true/,
  )
})

test("rejects shared Clerk and Convex identities", () => {
  const value = registry()
  value.environments.staging.clerkApplicationId = "app_production"
  value.environments.production.convexDeployment = "prod:staging-deployment"

  const errors = validateIsolationRegistry(value).errors.join("\n")
  assert.match(errors, /production.clerkApplicationId duplicates staging.clerkApplicationId/)
  assert.match(errors, /production.convexDeployment duplicates staging.convexDeployment/)
})

test("rejects shared mode when environment account IDs do not match", () => {
  const value = registry()
  value.environments.production.awsAccountId = "222222222222"

  assert.match(
    validateIsolationRegistry(value).errors.join("\n"),
    /must match awsAccountTopology.sharedAccountId/,
  )
})

test("requires exact hosted environments and isolation boundaries", () => {
  const value = registry()
  value.awsAccountTopology.environments.push("development")
  value.awsAccountTopology.isolationBoundaries = isolationBoundaries.slice(1)

  const errors = validateIsolationRegistry(value).errors.join("\n")
  assert.match(errors, /environments must contain exactly staging and production/)
  assert.match(errors, /must contain every required shared-account boundary/)
})

test("rejects malformed identities and duplicate development identity", () => {
  const value = registry()
  value.environments.staging.awsAccountId = "123"
  value.environments.production.convexDeployment = "dev:development-deployment"
  const errors = validateIsolationRegistry(value).errors.join("\n")
  assert.match(errors, /staging.awsAccountId has an invalid type or format/)
  assert.match(errors, /production.convexDeployment duplicates development.convexDeployment/)
})

test("requires topology governance metadata and traffic state", () => {
  const value = registry()
  value.awsAccountTopology.owner = ""
  value.awsAccountTopology.reason = null
  value.productionLearnerTrafficBlocked = "yes"
  const errors = validateIsolationRegistry(value).errors.join("\n")
  assert.match(errors, /owner must be a nonempty string/)
  assert.match(errors, /reason must be a nonempty string/)
  assert.match(errors, /productionLearnerTrafficBlocked must be boolean/)
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
  value.productionLearnerTrafficBlocked = true
  let executed = false
  const status = await runHostedCommand(["terraform", "plan", "staging"], {
    loadRegistry: async () => value,
    execute: () => { executed = true; return 0 },
  })
  assert.equal(status, 1)
  assert.equal(executed, false)
})

test("hosted Terraform command checks shared AWS identity and forwards arguments", async () => {
  let invocation
  let identityEnvironment
  const status = await runHostedCommand(["terraform", "plan", "production", "--", "-var-file=production.tfvars"], {
    environment: {
      AWS_ACCESS_KEY_ID: "ambient-key",
      AWS_PROFILE: "amplify-user",
      AWS_WEB_IDENTITY_TOKEN_FILE: "/tmp/ambient-token",
    },
    loadRegistry: async () => registry(),
    getAwsAccountId: (environment) => {
      identityEnvironment = environment
      return sharedAccountId
    },
    execute: (command, args, options) => { invocation = { command, args, options }; return 0 },
  })
  assert.equal(status, 0)
  assert.equal(invocation.command, "terraform")
  assert.deepEqual(invocation.args, [
    "-chdir=infra/aws/environments/production",
    "plan",
    `-var=expected_aws_account_id=${sharedAccountId}`,
    "-var-file=production.tfvars",
  ])
  for (const environment of [identityEnvironment, invocation.options.env]) {
    assert.equal(environment.AWS_PROFILE, "default")
    assert.equal(environment.AWS_DEFAULT_PROFILE, "default")
    assert.equal(environment.AWS_ACCESS_KEY_ID, undefined)
    assert.equal(environment.AWS_WEB_IDENTITY_TOKEN_FILE, undefined)
  }
})

test("hosted Terraform command rejects a different active account", async () => {
  let executed = false
  const status = await runHostedCommand(["terraform", "plan", "staging"], {
    loadRegistry: async () => registry(),
    awsAccountId: "222222222222",
    execute: () => { executed = true; return 0 },
  })
  assert.equal(status, 1)
  assert.equal(executed, false)
})
