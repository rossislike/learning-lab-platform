import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import test from "node:test"

import { validateIsolationRegistry } from "./validate-environment-isolation.mjs"
import { runHostedCommand } from "./run-hosted-command.mjs"

const sharedAccountId = "442359104502"
const backendRegistry = { accountId: sharedAccountId }

function hostedTerraformDependencies(overrides = {}) {
  return {
    loadBackendRegistry: () => backendRegistry,
    validateBackends: () => ({ ok: true }),
    acquireOperationLock: () => ({ ok: true }),
    verifyOperationLock: () => true,
    releaseOperationLock: () => true,
    teardownActive: false,
    readSharedAlarmLifecycle: () => false,
    writeSharedAlarmLifecycle: () => {},
    reconcileSharedAlarms: () => 0,
    ...overrides,
  }
}
const sharedClerkIdentity = {
  applicationId: "app_3GKhzAioaTZbOK6QwVEL8qxIHS3",
  instanceId: "ins_3GKhzB4WHOIij3p0UthvLWPmVCG",
  instanceType: "development",
  issuerDomain: "https://amazed-adder-35.clerk.accounts.dev",
}
const productionClerkIdentity = {
  applicationId: "app_production",
  instanceId: "ins_production",
  instanceType: "production",
  issuerDomain: "https://clerk.production.example.com",
}
const stagingDeployKey = "prod:staging-deployment|staging-secret"
const productionDeployKey = "prod:production-deployment|production-secret-marker"
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
    schemaVersion: 3,
    awsAccountTopology: {
      mode: "shared",
      sharedAccountId,
      environments: ["staging", "production"],
      isolationBoundaries,
      owner: "platform owner",
      reason: "Hosted environments share one account with environment-scoped resources.",
    },
    clerkApplicationTopology: {
      mode: "sharedDevelopmentStaging",
      ...sharedClerkIdentity,
      environments: ["development", "staging"],
      owner: "platform owner",
      reason: "Development and staging share the verified development identity.",
    },
    productionLearnerTrafficBlocked: false,
    environments: {
      development: {
        awsAccountId: null,
        clerk: { ...sharedClerkIdentity },
        convexDeployment: "dev:development-deployment",
      },
      staging: {
        awsAccountId: sharedAccountId,
        clerk: { ...sharedClerkIdentity },
        convexDeployment: "prod:staging-deployment",
      },
      production: {
        awsAccountId: sharedAccountId,
        clerk: { ...productionClerkIdentity },
        convexDeployment: "prod:production-deployment",
      },
      ...overrides,
    },
  }
}

test("accepts declared AWS and pinned development-staging Clerk sharing", () => {
  assert.deepEqual(validateIsolationRegistry(registry()), {
    blockers: [],
    errors: [],
    ready: true,
  })
})

test("pins the real production Clerk identity and blocked traffic gate", () => {
  const registered = JSON.parse(
    readFileSync("config/hosted-environments.json", "utf8"),
  )

  assert.deepEqual(registered.environments.production.clerk, {
    applicationId: "app_3HxpakMJmYEYqRjofDF3wrByUqx",
    instanceId: "ins_3Hxpwld1IGCSIDBX7vZ3qqzLkTq",
    instanceType: "production",
    issuerDomain: "https://clerk.learning-lab-platform.rumothy.com",
  })
  assert.equal(registered.productionLearnerTrafficBlocked, true)
})

test("Terraform isolation guards require the registered schema version", () => {
  const registeredSchemaVersion = JSON.parse(
    readFileSync("config/hosted-environments.json", "utf8"),
  ).schemaVersion

  for (const environment of ["staging", "production"]) {
    const isolation = readFileSync(
      `infra/aws/environments/${environment}/isolation.tf`,
      "utf8",
    )
    assert.match(
      isolation,
      new RegExp(`local\\.isolation_registry\\.schemaVersion == ${registeredSchemaVersion}\\b`),
      `${environment} Terraform guard must require registry schemaVersion ${registeredSchemaVersion}`,
    )
  }
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

test("reports one blocker for wholly missing production Clerk configuration", () => {
  const value = registry()
  value.environments.production.clerk = null
  value.productionLearnerTrafficBlocked = true

  assert.deepEqual(validateIsolationRegistry(value), {
    blockers: ["production.clerk is not configured"],
    errors: [],
    ready: false,
  })
})

test("does not report ready when development Clerk configuration is missing", () => {
  const value = registry()
  value.environments.development.clerk = null
  value.productionLearnerTrafficBlocked = true

  const result = validateIsolationRegistry(value)
  assert.equal(result.ready, false)
  assert.deepEqual(result.blockers, ["development.clerk is not configured"])
})

test("requires every production Clerk field once configuration starts", () => {
  const value = registry()
  value.environments.production.clerk = { applicationId: "app_production" }

  const result = validateIsolationRegistry(value)
  assert.deepEqual(result.blockers, [])
  assert.match(result.errors.join("\n"), /production.clerk.instanceId is required/)
  assert.match(result.errors.join("\n"), /production.clerk.instanceType is required/)
  assert.match(result.errors.join("\n"), /production.clerk.issuerDomain is required/)
})

test("requires production traffic to stay blocked while identities are missing", () => {
  const value = registry()
  value.environments.production.convexDeployment = null

  assert.match(
    validateIsolationRegistry(value).errors.join("\n"),
    /productionLearnerTrafficBlocked must remain true/,
  )
})

test("rejects registration of the shared application's production instance", () => {
  const value = registry()
  value.environments.production.clerk = {
    ...productionClerkIdentity,
    applicationId: sharedClerkIdentity.applicationId,
  }

  assert.match(
    validateIsolationRegistry(value).errors.join("\n"),
    /production.clerk.applicationId duplicates development.clerk.applicationId/,
  )
})

test("rejects production instance and issuer selection for staging", () => {
  const value = registry()
  value.environments.staging.clerk = { ...productionClerkIdentity }

  const errors = validateIsolationRegistry(value).errors.join("\n")
  assert.match(errors, /staging.clerk.instanceType must be development/)
  assert.match(errors, /staging.clerk.applicationId must match clerkApplicationTopology.applicationId/)
  assert.match(errors, /staging.clerk.instanceId must match clerkApplicationTopology.instanceId/)
  assert.match(errors, /staging.clerk.issuerDomain must match clerkApplicationTopology.issuerDomain/)
})

test("pins the Clerk sharing exception to the verified identity", () => {
  const value = registry()
  value.clerkApplicationTopology.applicationId = "app_substitute"
  value.clerkApplicationTopology.instanceId = "ins_substitute"
  value.clerkApplicationTopology.issuerDomain = "https://substitute.clerk.accounts.dev"

  const errors = validateIsolationRegistry(value).errors.join("\n")
  assert.match(errors, /applicationId must be app_3GKhzAioaTZbOK6QwVEL8qxIHS3/)
  assert.match(errors, /instanceId must be ins_3GKhzB4WHOIij3p0UthvLWPmVCG/)
  assert.match(errors, /issuerDomain must be https:\/\/amazed-adder-35\.clerk\.accounts\.dev/)
})

test("requires the declared Clerk share to match development and staging only", () => {
  const value = registry()
  value.clerkApplicationTopology.environments = ["staging", "production"]

  assert.match(
    validateIsolationRegistry(value).errors.join("\n"),
    /environments must contain exactly development and staging/,
  )
})

test("requires Clerk sharing governance metadata", () => {
  const value = registry()
  value.clerkApplicationTopology.mode = "shared"
  value.clerkApplicationTopology.instanceType = "production"
  value.clerkApplicationTopology.owner = ""
  value.clerkApplicationTopology.reason = null

  const errors = validateIsolationRegistry(value).errors.join("\n")
  assert.match(errors, /mode must be sharedDevelopmentStaging/)
  assert.match(errors, /instanceType must be development/)
  assert.match(errors, /owner must be a nonempty string/)
  assert.match(errors, /reason must be a nonempty string/)
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
  const status = await runHostedCommand(["terraform", "plan", "production", "--", "-var-file=production.tfvars"], hostedTerraformDependencies({
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
  }))
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

test("hosted Terraform apply enables shared alarms before applying the environment", async () => {
  const order = []
  const status = await runHostedCommand(["terraform", "apply", "staging"], hostedTerraformDependencies({
    loadRegistry: async () => registry(),
    awsAccountId: sharedAccountId,
    reconcileSharedAlarms: ({ enabled }) => { order.push(`alarms:${enabled}`); return 0 },
    execute: (command, args) => { order.push(`${command}:${args[1]}`); return 0 },
  }))
  assert.equal(status, 0)
  assert.deepEqual(order, ["alarms:true", "terraform:apply"])
})

test("hosted Terraform plan durably enables alarms and restores the prior setting on failure", async () => {
  const writes = []
  const status = await runHostedCommand(["terraform", "plan", "staging"], hostedTerraformDependencies({
    loadRegistry: async () => registry(),
    awsAccountId: sharedAccountId,
    writeSharedAlarmLifecycle: (enabled) => writes.push(enabled),
    execute: () => 1,
  }))
  assert.equal(status, 1)
  assert.deepEqual(writes, [true, false])
})

test("hosted Terraform commands reject destroy arguments", async () => {
  assert.equal(await runHostedCommand(["terraform", "plan", "staging", "--", "-destroy"]), 2)
  assert.equal(await runHostedCommand(["terraform", "plan", "staging", "--", "-out=/tmp/staging.plan"]), 2)
  assert.equal(await runHostedCommand(["terraform", "apply", "staging", "--", "saved.tfplan"]), 2)
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

test("hosted Convex command verifies issuer and preserves safe deploy flags", async () => {
  let issuerInvocation
  let deployInvocation
  const status = await runHostedCommand(
    ["convex", "deploy", "staging", "--", "--dry-run", "--message=verified"],
    {
      environment: { CONVEX_DEPLOY_KEY: stagingDeployKey },
      loadRegistry: async () => registry(),
      executeCapture: (command, args, options) => {
        issuerInvocation = { command, args, options }
        return { status: 0, stdout: `${sharedClerkIdentity.issuerDomain}\n` }
      },
      execute: (command, args, options) => {
        deployInvocation = { command, args, options }
        return 0
      },
    },
  )

  assert.equal(status, 0)
  assert.deepEqual(issuerInvocation.args, [
    "convex",
    "env",
    "get",
    "CLERK_JWT_ISSUER_DOMAIN",
  ])
  assert.deepEqual(deployInvocation.args, ["convex", "deploy", "--dry-run", "--message=verified"])
  for (const environment of [issuerInvocation.options.env, deployInvocation.options.env]) {
    assert.equal(environment.CONVEX_DEPLOY_KEY, stagingDeployKey)
    assert.equal(environment.CONVEX_DEPLOYMENT, "")
    assert.equal(environment.CONVEX_DEPLOYMENT_TOKEN, "")
    assert.equal(environment.CONVEX_SELF_HOSTED_URL, "")
    assert.equal(environment.CONVEX_SELF_HOSTED_ADMIN_KEY, "")
  }
})

test("hosted Convex command rejects target-changing forwarded flags", async () => {
  for (const forwarded of [
    ["--env-file", "other.env"],
    ["--env-file=other.env"],
    ["--preview-create=branch"],
    ["--preview-name=branch"],
    ["--preview-run=setup"],
    ["--url=https://other.example.com"],
    ["--admin-key=secret"],
    ["--deployment=other"],
  ]) {
    let loaded = false
    const status = await runHostedCommand(["convex", "deploy", "staging", "--", ...forwarded], {
      loadRegistry: async () => { loaded = true; return registry() },
    })
    assert.equal(status, 2, forwarded.join(" "))
    assert.equal(loaded, false, forwarded.join(" "))
  }
})

test("hosted Convex command cannot fall back to default production without a deploy key", async () => {
  let executed = false
  const messages = []
  const status = await runHostedCommand(["convex", "deploy", "staging"], {
    environment: {},
    loadRegistry: async () => registry(),
    reportError: (message) => messages.push(message),
    executeCapture: () => { executed = true; return { status: 0, stdout: "" } },
    execute: () => { executed = true; return 0 },
  })
  assert.equal(status, 1)
  assert.equal(executed, false)
  assert.match(messages.join("\n"), /CONVEX_DEPLOY_KEY must be scoped/)
})

test("hosted Convex command rejects malformed and incorrectly scoped deploy keys", async () => {
  for (const deployKey of [
    "prod:staging-deployment",
    "prod:staging-deployment|",
    "prod:staging-deployment|secret|extra",
    "prod:other-deployment|secret",
    "preview:team:project|secret",
  ]) {
    let executed = false
    const messages = []
    const status = await runHostedCommand(["convex", "deploy", "staging"], {
      environment: { CONVEX_DEPLOY_KEY: deployKey },
      loadRegistry: async () => registry(),
      reportError: (message) => messages.push(message),
      executeCapture: () => { executed = true; return { status: 0, stdout: "" } },
      execute: () => { executed = true; return 0 },
    })
    assert.equal(status, 1)
    assert.equal(executed, false)
    assert.equal(messages.join("\n").includes(deployKey), false)
  }
})

test("hosted Convex command rejects a production key for staging without emitting it", async () => {
  let executed = false
  const messages = []
  const status = await runHostedCommand(["convex", "deploy", "staging"], {
    environment: { CONVEX_DEPLOY_KEY: productionDeployKey },
    loadRegistry: async () => registry(),
    reportError: (message) => messages.push(message),
    executeCapture: () => { executed = true; return { status: 0, stdout: "" } },
    execute: () => { executed = true; return 0 },
  })
  const output = messages.join("\n")
  assert.equal(status, 1)
  assert.equal(executed, false)
  assert.equal(output.includes(productionDeployKey), false)
  assert.equal(output.includes("production-secret-marker"), false)
})

test("hosted Convex command rejects conflicting target inputs", async () => {
  for (const [key, value] of [
    ["CONVEX_DEPLOYMENT", "prod:staging-deployment"],
    ["CONVEX_DEPLOYMENT_TOKEN", "prod:staging-deployment|secret"],
    ["CONVEX_SELF_HOSTED_URL", "https://other.example.com"],
    ["CONVEX_SELF_HOSTED_ADMIN_KEY", "secret"],
  ]) {
    let executed = false
    const status = await runHostedCommand(["convex", "deploy", "staging"], {
      environment: { CONVEX_DEPLOY_KEY: stagingDeployKey, [key]: value },
      loadRegistry: async () => registry(),
      executeCapture: () => { executed = true; return { status: 0, stdout: "" } },
      execute: () => { executed = true; return 0 },
    })
    assert.equal(status, 1, key)
    assert.equal(executed, false, key)
  }
})

test("hosted Convex command blocks when deployed issuer does not match", async () => {
  let deployed = false
  const status = await runHostedCommand(["convex", "deploy", "staging"], {
    environment: { CONVEX_DEPLOY_KEY: stagingDeployKey },
    loadRegistry: async () => registry(),
    executeCapture: () => ({ status: 0, stdout: "https://other.clerk.accounts.dev\n" }),
    execute: () => { deployed = true; return 0 },
  })
  assert.equal(status, 1)
  assert.equal(deployed, false)
})

test("hosted Convex command blocks when issuer cannot be read", async () => {
  let deployed = false
  const messages = []
  const status = await runHostedCommand(["convex", "deploy", "staging"], {
    environment: { CONVEX_DEPLOY_KEY: stagingDeployKey },
    loadRegistry: async () => registry(),
    reportError: (message) => messages.push(message),
    executeCapture: () => ({ status: 1, stdout: "", stderr: stagingDeployKey }),
    execute: () => { deployed = true; return 0 },
  })
  assert.equal(status, 1)
  assert.equal(deployed, false)
  assert.equal(messages.join("\n").includes(stagingDeployKey), false)
  assert.equal(messages.join("\n").includes("staging-secret"), false)
})
