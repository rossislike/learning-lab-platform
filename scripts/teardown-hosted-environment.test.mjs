import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"

import { runTeardown, teardownOverride } from "./teardown-hosted-environment.mjs"

const account = "442359104502"
const defaultNow = Date.parse("2026-08-16T12:00:00Z")
const resourceDefinitions = [
  ["ecsCluster", "module.hosted_runner.aws_ecs_cluster.runner", "aws_ecs_cluster", "runner"],
  ["publicAlb", "module.hosted_runner.aws_lb.public[0]", "aws_lb", "public"],
  ["artifactBucket", "module.hosted_runner.aws_s3_bucket.artifacts_protected[0]", "aws_s3_bucket", "artifacts_protected"],
  ["checkpointBucket", "module.hosted_runner.aws_s3_bucket.checkpoints_protected[0]", "aws_s3_bucket", "checkpoints_protected"],
  ["albAccessLogBucket", "module.hosted_runner.aws_s3_bucket.alb_access_logs[0]", "aws_s3_bucket", "alb_access_logs"],
  ["runnerRepository", "module.hosted_runner.aws_ecr_repository.runner_protected[0]", "aws_ecr_repository", "runner_protected"],
  ["dispatcherRepository", "module.hosted_runner.aws_ecr_repository.dispatcher_protected[0]", "aws_ecr_repository", "dispatcher_protected"],
  ["gatewayRepository", "module.hosted_runner.aws_ecr_repository.gateway_protected[0]", "aws_ecr_repository", "gateway_protected"],
  ["egressProxyRepository", "module.hosted_runner.aws_ecr_repository.proxy_protected[0]", "aws_ecr_repository", "proxy_protected"],
]

function stateSnapshot(changes = {}) {
  const partition = changes.partition ?? "aws"
  const region = changes.region ?? "us-east-2"
  const identities = {
    ecsCluster: changes.clusterArn ?? `arn:${partition}:ecs:${region}:${account}:cluster/test`,
    publicAlb: `arn:${partition}:elasticloadbalancing:${region}:${account}:loadbalancer/app/test/123`,
    artifactBucket: "artifacts",
    checkpointBucket: "checkpoints",
    albAccessLogBucket: "alb-access-logs",
    runnerRepository: `arn:${partition}:ecr:${region}:${account}:repository/runner`,
    dispatcherRepository: `arn:${partition}:ecr:${region}:${account}:repository/dispatcher`,
    gatewayRepository: `arn:${partition}:ecr:${region}:${account}:repository/session-gateway`,
    egressProxyRepository: `arn:${partition}:ecr:${region}:${account}:repository/proxy`,
    ...changes.identities,
  }
  const missingAddresses = new Set(changes.missingAddresses ?? [])
  const missingIdentities = new Set(changes.missingIdentities ?? [])
  const resources = resourceDefinitions
    .filter(([, address]) => !missingAddresses.has(address))
    .map(([key, address, type, name]) => ({
      address,
      mode: "managed",
      type,
      name,
      values: missingIdentities.has(key)
        ? {}
        : type === "aws_s3_bucket" ? { bucket: identities[key], id: identities[key] } : { arn: identities[key] },
    }))
  return {
    format_version: "1.0",
    values: {
      outputs: changes.outputs ?? {},
      root_module: { child_modules: [{ address: "module.hosted_runner", resources }] },
    },
  }
}

function fixture() {
  const rootPath = mkdtempSync(join(tmpdir(), "teardown-test-"))
  mkdirSync(join(rootPath, "infra/aws/modules/hosted-runner"), { recursive: true })
  mkdirSync(join(rootPath, "infra/aws/environments/staging/.terraform"), { recursive: true })
  mkdirSync(join(rootPath, "infra/aws/environments/production/.terraform"), { recursive: true })
  return rootPath
}

function executor(rootPath, changes = {}) {
  let applyCalls = 0
  const calls = []
  const execute = (command, args, options = {}) => {
    calls.push([command, args])
    if (command === "aws" && args[0] === "sts") return { status: 0, stdout: `${changes.account ?? account}\n` }
    if (command === "terraform" && args[1] === "show" && args.includes("-json")) {
      return { status: changes.stateShowStatus ?? 0, stdout: JSON.stringify(stateSnapshot(changes)) }
    }
    if (command === "aws" && args[1] === "list-tasks") return { status: 0, stdout: JSON.stringify({ taskArns: changes.tasks ?? [] }) }
    if (command === "aws" && args[1] === "list-services") return { status: 0, stdout: JSON.stringify({ serviceArns: ["service"] }) }
    if (command === "aws" && args[1] === "describe-services") return { status: 0, stdout: JSON.stringify({ services: [{ desiredCount: changes.desired ?? 0, runningCount: 0, pendingCount: 0 }] }) }
    if (command === "aws" && args[0] === "s3api") {
      const bucket = args[args.indexOf("--bucket") + 1]
      return { status: 0, stdout: JSON.stringify({
        Versions: changes.versionsByBucket?.[bucket] ?? changes.versions ?? [],
        DeleteMarkers: changes.deleteMarkersByBucket?.[bucket] ?? changes.deleteMarkers ?? [],
      }) }
    }
    if (command === "aws" && args[0] === "ecr") {
      const repository = args[args.indexOf("--repository-name") + 1]
      return { status: 0, stdout: JSON.stringify({ imageDetails: changes.imagesByRepository?.[repository] ?? changes.images ?? [] }) }
    }
    if (command === "aws" && args[0] === "elbv2") {
      const override = join(rootPath, "infra/aws/modules/hosted-runner/teardown_override.tf")
      const enabled = changes.albLoggingEnabled ?? !existsSync(override)
      return { status: changes.albAttributeStatus ?? 0, stdout: JSON.stringify({ Attributes: [{ Key: "access_logs.s3.enabled", Value: String(enabled) }] }) }
    }
    if (command === "terraform" && args.includes("state")) {
      const defaultState = resourceDefinitions.map(([, address]) => address).join("\n") + "\n"
      const environment = args[0].split("/").at(-1)
      return { status: 0, stdout: changes.stateByEnvironment?.[environment] ?? changes.state ?? defaultState }
    }
    if (command === "terraform" && args.includes("plan")) {
      const environment = args[0].split("/").at(-1)
      writeFileSync(join(rootPath, `infra/aws/environments/${environment}/.terraform/${environment}-destroy.tfplan`), "valid plan")
      return { status: changes.planStatus ?? 0, stdout: "" }
    }
    if (command === "terraform" && args.includes("apply")) {
      applyCalls += 1
      const status = changes.applyStatuses?.[applyCalls - 1] ?? 0
      return { status, stdout: "" }
    }
    return { status: 0, stdout: options.capture ? "" : undefined }
  }
  return { execute, calls }
}

function run(rootPath, args, changes) {
  const options = changes ?? {}
  const fake = executor(rootPath, options)
  const sharedAlarmReconciliations = []
  return {
    status: runTeardown(args, {
      rootPath,
      execute: fake.execute,
      now: () => options.now ?? defaultNow,
      albLogDrainMs: options.albLogDrainMs ?? 0,
      loadBackendRegistry: () => ({ accountId: account }),
      validateBackends: () => ({ ok: true }),
      acquireOperationLock: () => ({ ok: true }),
      verifyOperationLock: () => true,
      releaseOperationLock: () => true,
      reconcileSharedAlarms: (reconcileOptions) => {
        sharedAlarmReconciliations.push(reconcileOptions)
        return options.sharedAlarmStatus ?? 0
      },
    }),
    sharedAlarmReconciliations,
    ...fake,
  }
}

test("rejects unknown and duplicate flags", () => {
  const root = fixture()
  try {
    assert.equal(run(root, ["audit", "staging", `--account=${account}`, "--wat=yes"]).status, 2)
    assert.equal(run(root, ["audit", "staging", `--account=${account}`, `--account=${account}`]).status, 2)
  } finally { rmSync(root, { recursive: true }) }
})

test("successful prepare, plan, apply, and cleanup transition", () => {
  const root = fixture()
  try {
    assert.equal(run(root, ["prepare", "staging", `--account=${account}`, `--confirm=prepare teardown staging in ${account}`]).status, 0)
    assert.equal(run(root, ["plan", "staging", `--account=${account}`, `--confirm=plan teardown staging in ${account}`]).status, 0)
    assert.equal(run(root, ["apply", "staging", `--account=${account}`, `--confirm=destroy staging in ${account}`]).status, 0)
    const cleanup = run(root, ["cleanup", "staging", `--account=${account}`], { state: "" })
    assert.equal(cleanup.status, 0)
    assert.equal(cleanup.sharedAlarmReconciliations.length, 1)
    assert.equal(cleanup.sharedAlarmReconciliations[0].enabled, false)
    assert.equal(existsSync(join(root, "infra/aws/modules/hosted-runner/.teardown-owner.json")), false)
  } finally { rmSync(root, { recursive: true }) }
})

test("cleanup retains shared alarms while the other environment remains deployed", () => {
  const root = fixture()
  try {
    assert.equal(run(root, ["prepare", "staging", `--account=${account}`, `--confirm=prepare teardown staging in ${account}`]).status, 0)
    const cleanup = run(root, ["cleanup", "staging", `--account=${account}`], {
      stateByEnvironment: { staging: "", production: "resource.one\n" },
    })
    assert.equal(cleanup.status, 0)
    assert.equal(cleanup.sharedAlarmReconciliations.length, 0)
  } finally { rmSync(root, { recursive: true }) }
})

test("cleanup preserves teardown ownership when final shared alarm removal fails", () => {
  const root = fixture()
  try {
    assert.equal(run(root, ["prepare", "staging", `--account=${account}`, `--confirm=prepare teardown staging in ${account}`]).status, 0)
    const cleanup = run(root, ["cleanup", "staging", `--account=${account}`], {
      state: "",
      sharedAlarmStatus: 1,
    })
    assert.equal(cleanup.status, 1)
    assert.equal(existsSync(join(root, "infra/aws/modules/hosted-runner/.teardown-owner.json")), true)
    assert.equal(existsSync(join(root, "infra/aws/modules/hosted-runner/teardown_override.tf")), true)
  } finally { rmSync(root, { recursive: true }) }
})

test("ownership prevents another environment from using the shared override", () => {
  const root = fixture()
  try {
    assert.equal(run(root, ["prepare", "staging", `--account=${account}`, `--confirm=prepare teardown staging in ${account}`]).status, 0)
    assert.equal(run(root, ["plan", "production", `--account=${account}`, `--confirm=plan teardown production in ${account}`]).status, 1)
  } finally { rmSync(root, { recursive: true }) }
})

test("prepare failure automatically restores protections and cleans ownership", () => {
  const root = fixture()
  try {
    assert.equal(run(root, ["prepare", "staging", `--account=${account}`, `--confirm=prepare teardown staging in ${account}`], { applyStatuses: [1, 0] }).status, 1)
    assert.equal(existsSync(join(root, "infra/aws/modules/hosted-runner/teardown_override.tf")), false)
    assert.equal(existsSync(join(root, "infra/aws/modules/hosted-runner/.teardown-owner.json")), false)
  } finally { rmSync(root, { recursive: true }) }
})

test("prepare verifies ALB logging is disabled and records the drain start", () => {
  const root = fixture()
  try {
    const result = run(root, ["prepare", "staging", `--account=${account}`, `--confirm=prepare teardown staging in ${account}`])
    assert.equal(result.status, 0)
    assert.equal(result.calls.some(([command, args]) => command === "aws" && args[0] === "elbv2"), true)
    const owner = JSON.parse(readFileSync(join(root, "infra/aws/modules/hosted-runner/.teardown-owner.json"), "utf8"))
    assert.equal(owner.version, 2)
    assert.equal(owner.albAccessLoggingDisabledAt, new Date(defaultNow).toISOString())
  } finally { rmSync(root, { recursive: true }) }
})

test("prepare restores normal protections when ALB logging remains enabled", () => {
  const root = fixture()
  try {
    const result = run(
      root,
      ["prepare", "staging", `--account=${account}`, `--confirm=prepare teardown staging in ${account}`],
      { albLoggingEnabled: true },
    )
    assert.equal(result.status, 1)
    assert.equal(result.calls.filter(([command, args]) => command === "terraform" && args.includes("apply")).length, 2)
    assert.equal(existsSync(join(root, "infra/aws/modules/hosted-runner/teardown_override.tf")), false)
    assert.equal(existsSync(join(root, "infra/aws/modules/hosted-runner/.teardown-owner.json")), false)
  } finally { rmSync(root, { recursive: true }) }
})

test("abort restores protections and removes plans and ownership", () => {
  const root = fixture()
  try {
    assert.equal(run(root, ["prepare", "staging", `--account=${account}`, `--confirm=prepare teardown staging in ${account}`]).status, 0)
    assert.equal(run(root, ["plan", "staging", `--account=${account}`, `--confirm=plan teardown staging in ${account}`]).status, 0)
    const result = run(root, ["abort", "staging", `--account=${account}`, `--confirm=abort teardown staging in ${account}`], { state: "resource.one\n" })
    assert.equal(result.status, 0)
    assert.equal(result.calls.some(([, args]) => args.includes("apply")), true)
    assert.equal(existsSync(join(root, "infra/aws/environments/staging/.terraform/staging-destroy.tfplan")), false)
  } finally { rmSync(root, { recursive: true }) }
})

test("failed restore keeps ownership and override active", () => {
  const root = fixture()
  try {
    assert.equal(run(root, ["prepare", "staging", `--account=${account}`, `--confirm=prepare teardown staging in ${account}`], { applyStatuses: [0] }).status, 0)
    assert.equal(run(root, ["abort", "staging", `--account=${account}`, `--confirm=abort teardown staging in ${account}`], { applyStatuses: [1] }).status, 1)
    assert.equal(existsSync(join(root, "infra/aws/modules/hosted-runner/teardown_override.tf")), true)
  } finally { rmSync(root, { recursive: true }) }
})

test("plan preflight blocks active workloads, retained objects, and images", () => {
  for (const changes of [
    { tasks: ["task"] },
    { desired: 1 },
    { versions: [{}] },
    { versionsByBucket: { "alb-access-logs": [{}] } },
    { deleteMarkersByBucket: { "alb-access-logs": [{}] } },
    { imagesByRepository: { runner: [{}] } },
    { imagesByRepository: { dispatcher: [{}] } },
    { imagesByRepository: { "session-gateway": [{}] } },
    { imagesByRepository: { proxy: [{}] } },
  ]) {
    const root = fixture()
    try {
      assert.equal(run(root, ["prepare", "staging", `--account=${account}`, `--confirm=prepare teardown staging in ${account}`]).status, 0)
      assert.equal(run(root, ["plan", "staging", `--account=${account}`, `--confirm=plan teardown staging in ${account}`], changes).status, 1)
    } finally { rmSync(root, { recursive: true }) }
  }
})

test("plan enforces the ALB delivery drain window before bucket inspection", () => {
  const root = fixture()
  try {
    assert.equal(run(root, ["prepare", "staging", `--account=${account}`, `--confirm=prepare teardown staging in ${account}`]).status, 0)
    const early = run(
      root,
      ["plan", "staging", `--account=${account}`, `--confirm=plan teardown staging in ${account}`],
      { now: defaultNow + 599_999, albLogDrainMs: 600_000 },
    )
    assert.equal(early.status, 1)
    assert.equal(early.calls.some(([command, args]) => command === "aws" && args[0] === "s3api"), false)
    assert.equal(run(
      root,
      ["plan", "staging", `--account=${account}`, `--confirm=plan teardown staging in ${account}`],
      { now: defaultNow + 600_000, albLogDrainMs: 600_000 },
    ).status, 0)
  } finally { rmSync(root, { recursive: true }) }
})

test("an ALB bucket in state is checked even when root outputs are absent", () => {
  const root = fixture()
  try {
    assert.equal(run(root, ["prepare", "staging", `--account=${account}`, `--confirm=prepare teardown staging in ${account}`], { outputs: {} }).status, 0)
    const result = run(
      root,
      ["plan", "staging", `--account=${account}`, `--confirm=plan teardown staging in ${account}`],
      { outputs: {}, versionsByBucket: { "alb-access-logs": [{}] } },
    )
    assert.equal(result.status, 1)
    assert.equal(result.calls.some(([command, args]) => command === "aws" && args[0] === "s3api" && args.includes("alb-access-logs")), true)
  } finally { rmSync(root, { recursive: true }) }
})

test("prepare fails closed when an ALB bucket in state has no identity", () => {
  const root = fixture()
  try {
    const result = run(
      root,
      ["prepare", "staging", `--account=${account}`, `--confirm=prepare teardown staging in ${account}`],
      { missingIdentities: ["albAccessLogBucket"] },
    )
    assert.equal(result.status, 1)
    assert.equal(result.calls.some(([command, args]) => command === "terraform" && args.includes("apply")), false)
    assert.equal(existsSync(join(root, "infra/aws/modules/hosted-runner/.teardown-owner.json")), false)
  } finally { rmSync(root, { recursive: true }) }
})

test("guarded planning resumes when only the ALB log bucket remains", () => {
  const root = fixture()
  const missingAddresses = resourceDefinitions
    .filter(([key]) => key !== "albAccessLogBucket")
    .map(([, address]) => address)
  try {
    assert.equal(run(root, ["prepare", "staging", `--account=${account}`, `--confirm=prepare teardown staging in ${account}`]).status, 0)
    const planned = run(
      root,
      ["plan", "staging", `--account=${account}`, `--confirm=plan teardown staging in ${account}`],
      { missingAddresses },
    )
    assert.equal(planned.status, 0)
    assert.equal(planned.calls.some(([command, args]) => command === "aws" && ["ecs", "elbv2", "ecr"].includes(args[0])), false)
    assert.equal(planned.calls.some(([command, args]) => command === "aws" && args[0] === "s3api"), true)
    assert.equal(run(
      root,
      ["apply", "staging", `--account=${account}`, `--confirm=destroy staging in ${account}`],
      { missingAddresses },
    ).status, 0)
  } finally { rmSync(root, { recursive: true }) }
})

test("partial recovery does not skip a remaining resource missing from owner inventory", () => {
  const root = fixture()
  try {
    assert.equal(run(root, ["prepare", "staging", `--account=${account}`, `--confirm=prepare teardown staging in ${account}`]).status, 0)
    const ownerPath = join(root, "infra/aws/modules/hosted-runner/.teardown-owner.json")
    const owner = JSON.parse(readFileSync(ownerPath, "utf8"))
    delete owner.inventory.resources.albAccessLogBucket
    writeFileSync(ownerPath, JSON.stringify(owner))
    const result = run(root, ["plan", "staging", `--account=${account}`, `--confirm=plan teardown staging in ${account}`])
    assert.equal(result.status, 1)
    assert.equal(result.calls.some(([command, args]) => command === "aws" && ["ecs", "elbv2", "s3api", "ecr"].includes(args[0])), false)
  } finally { rmSync(root, { recursive: true }) }
})

test("preflight applies the cluster region to every regional AWS inspection", () => {
  const root = fixture()
  try {
    assert.equal(run(root, ["prepare", "staging", `--account=${account}`, `--confirm=prepare teardown staging in ${account}`]).status, 0)
    const result = run(root, ["plan", "staging", `--account=${account}`, `--confirm=plan teardown staging in ${account}`])
    assert.equal(result.status, 0)
    const regionalCalls = result.calls.filter(([command, args]) => command === "aws" && ["ecs", "elbv2", "s3api", "ecr"].includes(args[0]))
    assert.ok(regionalCalls.length > 0)
    for (const [, args] of regionalCalls) {
      assert.deepEqual(args.slice(args.indexOf("--region"), args.indexOf("--region") + 2), ["--region", "us-east-2"])
    }
  } finally { rmSync(root, { recursive: true }) }
})

test("malformed or non-ECS cluster ARN blocks before AWS resource inspection", () => {
  for (const clusterArn of ["not-an-arn", "arn:aws:s3:us-east-2:442359104502:cluster/test", "arn:other:ecs:us-east-2:442359104502:cluster/test"]) {
    const root = fixture()
    try {
      assert.equal(run(root, ["prepare", "staging", `--account=${account}`, `--confirm=prepare teardown staging in ${account}`]).status, 0)
      const result = run(root, ["plan", "staging", `--account=${account}`, `--confirm=plan teardown staging in ${account}`], { clusterArn })
      assert.equal(result.status, 1)
      assert.equal(result.calls.some(([command, args]) => command === "aws" && ["ecs", "s3api", "ecr"].includes(args[0])), false)
    } finally { rmSync(root, { recursive: true }) }
  }
})

test("preflight accepts AWS China and GovCloud ECS cluster ARNs", () => {
  for (const [partition, region] of [
    ["aws-cn", "cn-north-1"],
    ["aws-us-gov", "us-gov-west-1"],
  ]) {
    const root = fixture()
    try {
      assert.equal(run(root, ["prepare", "staging", `--account=${account}`, `--confirm=prepare teardown staging in ${account}`], { partition, region }).status, 0)
      const result = run(root, ["plan", "staging", `--account=${account}`, `--confirm=plan teardown staging in ${account}`], { partition, region })
      assert.equal(result.status, 0)
      const ecsCall = result.calls.find(([command, args]) => command === "aws" && args[0] === "ecs")
      assert.deepEqual(ecsCall[1].slice(2, 4), ["--region", region])
    } finally { rmSync(root, { recursive: true }) }
  }
})

test("generated teardown override is terraform fmt stable", () => {
  const root = fixture()
  try {
    const path = join(root, "teardown_override.tf")
    writeFileSync(path, teardownOverride)
    const result = spawnSync("terraform", ["fmt", "-check", path], { encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr || result.stdout)
  } finally { rmSync(root, { recursive: true }) }
})

test("generated teardown override unlocks every protected ECR repository", () => {
  for (const repository of ["runner", "dispatcher", "gateway", "proxy"]) {
    const start = teardownOverride.indexOf(`resource "aws_ecr_repository" "${repository}_protected"`)
    const end = teardownOverride.indexOf("\nresource ", start + 1)
    const block = teardownOverride.slice(start, end === -1 ? undefined : end)
    assert.ok(start >= 0)
    assert.match(block, /lifecycle \{\s+prevent_destroy = false\s+\}/)
  }
})

test("generated teardown override unlocks every protected data resource", () => {
  for (const [type, name] of [
    ["aws_kms_key", "data_protected"],
    ["aws_kms_key", "service_secrets_protected"],
    ["aws_secretsmanager_secret", "dispatcher_runner_shared_secret_protected"],
    ["aws_s3_bucket", "artifacts_protected"],
    ["aws_s3_bucket", "checkpoints_protected"],
    ["aws_s3_bucket", "alb_access_logs"],
  ]) {
    const start = teardownOverride.indexOf(`resource "${type}" "${name}"`)
    const end = teardownOverride.indexOf("\nresource ", start + 1)
    const block = teardownOverride.slice(start, end === -1 ? undefined : end)
    assert.ok(start >= 0)
    assert.match(block, /lifecycle \{\s+prevent_destroy = false\s+\}/)
  }
})

test("generated teardown override disables ALB log delivery", () => {
  assert.match(teardownOverride, /variable "enable_alb_access_logging" \{\s+default = false\s+\}/)
})

test("guarded prepare temporarily enables scenario deletion through Terraform", () => {
  const root = fixture()
  try {
    const result = run(root, [
      "prepare",
      "staging",
      `--account=${account}`,
      `--confirm=prepare teardown staging in ${account}`,
    ])
    assert.equal(result.status, 0)
    assert.match(teardownOverride, /allow_scenario_artifact_deletion/)
    const apply = result.calls.find(
      ([command, args]) => command === "terraform" && args.includes("apply"),
    )
    assert.ok(apply)
    assert.ok(
      apply[1].includes(
        "-target=module.hosted_runner.aws_s3_bucket_policy.artifacts",
      ),
    )
  } finally {
    rmSync(root, { recursive: true })
  }
})

test("apply rejects missing and tampered plans", () => {
  const root = fixture()
  try {
    assert.equal(run(root, ["prepare", "staging", `--account=${account}`, `--confirm=prepare teardown staging in ${account}`]).status, 0)
    assert.equal(run(root, ["apply", "staging", `--account=${account}`, `--confirm=destroy staging in ${account}`]).status, 1)
    assert.equal(run(root, ["plan", "staging", `--account=${account}`, `--confirm=plan teardown staging in ${account}`]).status, 0)
    writeFileSync(join(root, "infra/aws/environments/staging/.terraform/staging-destroy.tfplan"), "tampered")
    assert.equal(run(root, ["apply", "staging", `--account=${account}`, `--confirm=destroy staging in ${account}`]).status, 1)
  } finally { rmSync(root, { recursive: true }) }
})

test("apply reruns preflight and blocks resources that appeared after planning", () => {
  const root = fixture()
  try {
    assert.equal(run(root, ["prepare", "staging", `--account=${account}`, `--confirm=prepare teardown staging in ${account}`]).status, 0)
    assert.equal(run(root, ["plan", "staging", `--account=${account}`, `--confirm=plan teardown staging in ${account}`]).status, 0)
    assert.equal(run(root, ["apply", "staging", `--account=${account}`, `--confirm=destroy staging in ${account}`], { tasks: ["new-task"] }).status, 1)
  } finally { rmSync(root, { recursive: true }) }
})

test("a failed replan invalidates the previous saved plan", () => {
  const root = fixture()
  try {
    assert.equal(run(root, ["prepare", "staging", `--account=${account}`, `--confirm=prepare teardown staging in ${account}`]).status, 0)
    assert.equal(run(root, ["plan", "staging", `--account=${account}`, `--confirm=plan teardown staging in ${account}`]).status, 0)
    assert.equal(run(
      root,
      ["plan", "staging", `--account=${account}`, `--confirm=plan teardown staging in ${account}`],
      { tasks: ["new-task"] },
    ).status, 1)
    assert.equal(existsSync(join(root, "infra/aws/environments/staging/.terraform/staging-destroy.tfplan")), false)
    assert.equal(existsSync(join(root, "infra/aws/environments/staging/.terraform/staging-destroy.tfplan.json")), false)
  } finally { rmSync(root, { recursive: true }) }
})

test("apply blocks an ALB delete marker delivered after planning", () => {
  const root = fixture()
  try {
    assert.equal(run(root, ["prepare", "staging", `--account=${account}`, `--confirm=prepare teardown staging in ${account}`]).status, 0)
    assert.equal(run(root, ["plan", "staging", `--account=${account}`, `--confirm=plan teardown staging in ${account}`]).status, 0)
    assert.equal(run(
      root,
      ["apply", "staging", `--account=${account}`, `--confirm=destroy staging in ${account}`],
      { deleteMarkersByBucket: { "alb-access-logs": [{ Key: "late", VersionId: "1" }] } },
    ).status, 1)
  } finally { rmSync(root, { recursive: true }) }
})

test("abort recovers an interrupted prepare with owner but no override", () => {
  const root = fixture()
  try {
    writeFileSync(join(root, "infra/aws/modules/hosted-runner/.teardown-owner.json"), JSON.stringify({ version: 1, environment: "staging", account }))
    const result = run(root, ["abort", "staging", `--account=${account}`, `--confirm=abort teardown staging in ${account}`], { state: "resource.one\n" })
    assert.equal(result.status, 0)
    assert.equal(result.calls.some(([, args]) => args.includes("apply")), true)
    assert.equal(existsSync(join(root, "infra/aws/modules/hosted-runner/.teardown-owner.json")), false)
  } finally { rmSync(root, { recursive: true }) }
})

test("abort cleans a version 2 ownership lock interrupted before inventory capture", () => {
  const root = fixture()
  try {
    writeFileSync(join(root, "infra/aws/modules/hosted-runner/.teardown-owner.json"), JSON.stringify({ version: 2, environment: "staging", account }))
    const result = run(root, ["abort", "staging", `--account=${account}`, `--confirm=abort teardown staging in ${account}`])
    assert.equal(result.status, 0)
    assert.equal(result.calls.some(([, args]) => args.includes("apply")), false)
    assert.equal(existsSync(join(root, "infra/aws/modules/hosted-runner/.teardown-owner.json")), false)
  } finally { rmSync(root, { recursive: true }) }
})

test("abort with empty state cleans interrupted post-destroy metadata without applying", () => {
  const root = fixture()
  try {
    writeFileSync(join(root, "infra/aws/modules/hosted-runner/.teardown-owner.json"), JSON.stringify({ version: 1, environment: "staging", account }))
    const result = run(root, ["abort", "staging", `--account=${account}`, `--confirm=abort teardown staging in ${account}`], { state: "" })
    assert.equal(result.status, 0)
    assert.equal(result.calls.some(([, args]) => args.includes("apply")), false)
  } finally { rmSync(root, { recursive: true }) }
})

test("abort refuses to recreate resources after a partial destroy", () => {
  const root = fixture()
  const missingAddresses = ["module.hosted_runner.aws_ecs_cluster.runner"]
  try {
    assert.equal(run(root, ["prepare", "staging", `--account=${account}`, `--confirm=prepare teardown staging in ${account}`]).status, 0)
    const result = run(
      root,
      ["abort", "staging", `--account=${account}`, `--confirm=abort teardown staging in ${account}`],
      { missingAddresses },
    )
    assert.equal(result.status, 1)
    assert.equal(result.calls.some(([command, args]) => command === "terraform" && args.includes("apply")), false)
  } finally { rmSync(root, { recursive: true }) }
})

test("abort refuses an unexpected override even with matching ownership", () => {
  const root = fixture()
  try {
    writeFileSync(join(root, "infra/aws/modules/hosted-runner/.teardown-owner.json"), JSON.stringify({ version: 1, environment: "staging", account }))
    writeFileSync(join(root, "infra/aws/modules/hosted-runner/teardown_override.tf"), "unexpected")
    assert.equal(run(root, ["abort", "staging", `--account=${account}`, `--confirm=abort teardown staging in ${account}`]).status, 1)
  } finally { rmSync(root, { recursive: true }) }
})

test("cleanup refuses nonempty state and preserves teardown files", () => {
  const root = fixture()
  try {
    assert.equal(run(root, ["prepare", "staging", `--account=${account}`, `--confirm=prepare teardown staging in ${account}`]).status, 0)
    assert.equal(run(root, ["cleanup", "staging", `--account=${account}`], { state: "resource.one\n" }).status, 1)
    assert.equal(readFileSync(join(root, "infra/aws/modules/hosted-runner/.teardown-owner.json"), "utf8").includes("staging"), true)
  } finally { rmSync(root, { recursive: true }) }
})
