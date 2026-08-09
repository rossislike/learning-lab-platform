import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"

import { runTeardown, teardownOverride } from "./teardown-hosted-environment.mjs"

const account = "442359104502"

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
    if (command === "terraform" && args[1] === "output") return { status: 0, stdout: JSON.stringify({
      ecs_cluster_arn: { value: changes.clusterArn ?? "arn:aws:ecs:us-east-2:442359104502:cluster/test" }, artifact_bucket: { value: "artifacts" }, checkpoint_bucket: { value: "checkpoints" },
      runner_ecr_repository_url: { value: "host/runner" }, dispatcher_ecr_repository_url: { value: "host/dispatcher" },
      gateway_ecr_repository_url: { value: "host/session-gateway" }, egress_proxy_repository_url: { value: "host/proxy" },
    }) }
    if (command === "aws" && args[1] === "list-tasks") return { status: 0, stdout: JSON.stringify({ taskArns: changes.tasks ?? [] }) }
    if (command === "aws" && args[1] === "list-services") return { status: 0, stdout: JSON.stringify({ serviceArns: ["service"] }) }
    if (command === "aws" && args[1] === "describe-services") return { status: 0, stdout: JSON.stringify({ services: [{ desiredCount: changes.desired ?? 0, runningCount: 0, pendingCount: 0 }] }) }
    if (command === "aws" && args[0] === "s3api") return { status: 0, stdout: JSON.stringify({ Versions: changes.versions ?? [], DeleteMarkers: [] }) }
    if (command === "aws" && args[0] === "ecr") {
      const repository = args[args.indexOf("--repository-name") + 1]
      return { status: 0, stdout: JSON.stringify({ imageDetails: changes.imagesByRepository?.[repository] ?? changes.images ?? [] }) }
    }
    if (command === "terraform" && args.includes("state")) return { status: 0, stdout: changes.state ?? "" }
    if (command === "terraform" && args.includes("plan")) {
      writeFileSync(join(rootPath, "infra/aws/environments/staging/.terraform/staging-destroy.tfplan"), "valid plan")
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
  const fake = executor(rootPath, changes)
  return { status: runTeardown(args, { rootPath, execute: fake.execute }), ...fake }
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
    assert.equal(run(root, ["cleanup", "staging", `--account=${account}`]).status, 0)
    assert.equal(existsSync(join(root, "infra/aws/modules/hosted-runner/.teardown-owner.json")), false)
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

test("preflight applies the cluster region to every regional AWS inspection", () => {
  const root = fixture()
  try {
    assert.equal(run(root, ["prepare", "staging", `--account=${account}`, `--confirm=prepare teardown staging in ${account}`]).status, 0)
    const result = run(root, ["plan", "staging", `--account=${account}`, `--confirm=plan teardown staging in ${account}`])
    assert.equal(result.status, 0)
    const regionalCalls = result.calls.filter(([command, args]) => command === "aws" && ["ecs", "s3api", "ecr"].includes(args[0]))
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
  for (const [clusterArn, region] of [
    ["arn:aws-cn:ecs:cn-north-1:442359104502:cluster/test", "cn-north-1"],
    ["arn:aws-us-gov:ecs:us-gov-west-1:442359104502:cluster/test", "us-gov-west-1"],
  ]) {
    const root = fixture()
    try {
      assert.equal(run(root, ["prepare", "staging", `--account=${account}`, `--confirm=prepare teardown staging in ${account}`]).status, 0)
      const result = run(root, ["plan", "staging", `--account=${account}`, `--confirm=plan teardown staging in ${account}`], { clusterArn })
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
    assert.match(
      teardownOverride,
      new RegExp(`resource "aws_ecr_repository" "${repository}_protected"`),
    )
  }
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

test("abort with empty state cleans interrupted post-destroy metadata without applying", () => {
  const root = fixture()
  try {
    writeFileSync(join(root, "infra/aws/modules/hosted-runner/.teardown-owner.json"), JSON.stringify({ version: 1, environment: "staging", account }))
    const result = run(root, ["abort", "staging", `--account=${account}`, `--confirm=abort teardown staging in ${account}`])
    assert.equal(result.status, 0)
    assert.equal(result.calls.some(([, args]) => args.includes("apply")), false)
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
