import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
  learningLabAlarmKeys,
  readSharedAlarmLifecycle,
  reconcileSharedAlarms,
  sharedAlarmTeardownOverride,
} from "./shared-alarm-lifecycle.mjs"

const account = "442359104502"
const region = "us-west-2"
const alarmPrefix = "learning-lab-platform-"

function alarmAddress(key) {
  return `aws_cloudwatch_metric_alarm.security["${key}"]`
}

function fixture(enabled = true) {
  const rootPath = mkdtempSync(join(tmpdir(), "shared-alarm-lifecycle-"))
  for (const directory of [
    "infra/aws/account-security/.terraform",
    "infra/aws/environments/staging/.terraform",
    "infra/aws/environments/production/.terraform",
  ]) mkdirSync(join(rootPath, directory), { recursive: true })
  writeFileSync(
    join(rootPath, "infra/aws/account-security/zz-learning-lab-alarms.auto.tfvars.json"),
    `${JSON.stringify({ enable_learning_lab_alarms: enabled }, null, 2)}\n`,
  )
  return rootPath
}

function resourceChanges(enabled, changes = {}) {
  if (changes.resourceChanges) return changes.resourceChanges
  const keys = changes.keys ?? learningLabAlarmKeys
  return keys.map((key) => ({
    address: alarmAddress(key),
    type: "aws_cloudwatch_metric_alarm",
    name: "security",
    index: key,
    change: enabled
      ? { actions: ["create"], before: null, after: { alarm_name: `${alarmPrefix}${key}` } }
      : { actions: ["delete"], before: { alarm_name: `${alarmPrefix}${key}` }, after: null },
  }))
}

function executor(rootPath, enabled, changes = {}) {
  const calls = []
  let applied = false
  let environmentStateReads = 0
  const initialAlarmKeys = changes.initialAlarmKeys ?? (enabled ? [] : learningLabAlarmKeys)
  const execute = (command, args) => {
    calls.push([command, args])
    if (command === "terraform" && args[1] === "workspace") {
      const rootName = args[0].split("/").at(-1)
      return { status: 0, stdout: `${changes.workspaceByRoot?.[rootName] ?? "default"}\n` }
    }
    if (command === "terraform" && args[1] === "state") {
      if (args[0].includes("environments/")) {
        environmentStateReads += 1
        const state = changes.environmentStateAtRead?.[environmentStateReads - 1] ?? changes.environmentState ?? ""
        return { status: 0, stdout: state }
      }
      const keys = applied ? (enabled ? learningLabAlarmKeys : []) : initialAlarmKeys
      const extra = changes.extraStateAddress ? [changes.extraStateAddress] : []
      return { status: 0, stdout: [...keys.map(alarmAddress), ...extra].join("\n") }
    }
    if (command === "terraform" && args[1] === "plan") {
      const output = args.find((arg) => arg.startsWith("-out="))?.slice("-out=".length)
      writeFileSync(join(rootPath, "infra/aws/account-security", output), "saved-plan")
      return { status: changes.planStatus ?? 0, stdout: "" }
    }
    if (command === "terraform" && args[1] === "show") {
      return { status: 0, stdout: JSON.stringify({
        variables: {
          expected_aws_account_id: { value: account },
          aws_region: { value: changes.region ?? region },
        },
        resource_changes: resourceChanges(enabled, changes),
      }) }
    }
    if (command === "terraform" && args[1] === "apply") {
      applied = true
      return { status: changes.applyStatus ?? 0, stdout: "" }
    }
    if (command === "aws" && args[0] === "cloudwatch") {
      const names = enabled ? learningLabAlarmKeys.map((key) => ({ AlarmName: `${alarmPrefix}${key}` })) : []
      return { status: 0, stdout: JSON.stringify({ MetricAlarms: changes.liveAlarms ?? names, CompositeAlarms: [] }) }
    }
    return { status: 1, stdout: "" }
  }
  return { execute, calls }
}

function run(rootPath, enabled, changes = {}) {
  const fake = executor(rootPath, enabled, changes)
  const status = reconcileSharedAlarms({
    account,
    enabled,
    execute: fake.execute,
    rootPath,
    backendRegistry: { accountId: account },
    verifyOperationLock: changes.verifyOperationLock ?? (() => true),
    validateBackends: () => ({ ok: true }),
    planId: "12345678-abcd",
    beforeApply: changes.beforeApply,
    ...changes.dependencies,
  })
  return { status, ...fake }
}

test("deletes only the exact 12 alarm instances and uses the plan region", () => {
  const rootPath = fixture(true)
  try {
    const result = run(rootPath, false, {
      dependencies: { validateBackends: () => ({ ok: true }) },
    })
    assert.equal(result.status, 0)
    const cloudwatch = result.calls.find(([command, args]) => command === "aws" && args[0] === "cloudwatch")
    assert.deepEqual(cloudwatch[1].slice(cloudwatch[1].indexOf("--region"), cloudwatch[1].indexOf("--region") + 2), ["--region", region])
    assert.equal(readSharedAlarmLifecycle(rootPath), false)
    assert.equal(existsSync(join(rootPath, "infra/aws/account-security/learning_lab_alarms_teardown_override.tf")), false)
  } finally { rmSync(rootPath, { recursive: true }) }
})

test("rejects an unrelated imported alarm and a wrong prior alarm name", () => {
  for (const changes of [
    { extraStateAddress: "aws_cloudwatch_metric_alarm.security[\"unrelated\"]" },
    { resourceChanges: [{
      address: alarmAddress("root-account-usage"),
      type: "aws_cloudwatch_metric_alarm",
      name: "security",
      index: "root-account-usage",
      change: { actions: ["delete"], before: { alarm_name: "other-project-alarm" }, after: null },
    }] },
  ]) {
    const rootPath = fixture(true)
    try {
      const result = run(rootPath, false, changes)
      assert.equal(result.status, 1)
      assert.equal(result.calls.some(([command, args]) => command === "terraform" && args[1] === "apply"), false)
      assert.equal(readSharedAlarmLifecycle(rootPath), true)
    } finally { rmSync(rootPath, { recursive: true }) }
  }
})

test("detects plan replacement after inspection", () => {
  const rootPath = fixture(true)
  try {
    const result = run(rootPath, false, {
      beforeApply: ({ planPath }) => writeFileSync(planPath, "replaced-plan"),
    })
    assert.equal(result.status, 1)
    assert.equal(result.calls.some(([command, args]) => command === "terraform" && args[1] === "apply"), false)
    assert.equal(readSharedAlarmLifecycle(rootPath), true)
  } finally { rmSync(rootPath, { recursive: true }) }
})

test("rechecks both environment states immediately before deletion", () => {
  const rootPath = fixture(true)
  try {
    const result = run(rootPath, false, {
      environmentStateAtRead: ["", "", "", "new.resource\n"],
    })
    assert.equal(result.status, 1)
    assert.equal(result.calls.some(([command, args]) => command === "terraform" && args[1] === "apply"), false)
  } finally { rmSync(rootPath, { recursive: true }) }
})

test("enables all alarms before hosted provisioning", () => {
  const rootPath = fixture(false)
  try {
    const result = run(rootPath, true)
    assert.equal(result.status, 0)
    assert.equal(readSharedAlarmLifecycle(rootPath), true)
  } finally { rmSync(rootPath, { recursive: true }) }
})

test("tracked auto variable overrides a stale terraform.tfvars true value", () => {
  const rootPath = mkdtempSync(join(tmpdir(), "alarm-var-precedence-"))
  try {
    writeFileSync(join(rootPath, "main.tf"), `variable "enable_learning_lab_alarms" { type = bool }\n`)
    writeFileSync(join(rootPath, "terraform.tfvars"), "enable_learning_lab_alarms = true\n")
    writeFileSync(join(rootPath, "zz-learning-lab-alarms.auto.tfvars.json"), '{"enable_learning_lab_alarms":false}\n')
    const result = spawnSync("terraform", [`-chdir=${rootPath}`, "console"], { input: "var.enable_learning_lab_alarms\n", encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), "false")
  } finally { rmSync(rootPath, { recursive: true }) }
})

test("generated alarm override is formatted and disables prevent_destroy", () => {
  const rootPath = mkdtempSync(join(tmpdir(), "alarm-override-"))
  try {
    const path = join(rootPath, "override.tf")
    writeFileSync(path, sharedAlarmTeardownOverride)
    const result = spawnSync("terraform", ["fmt", "-check", path], { encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(sharedAlarmTeardownOverride, /lifecycle \{\s+prevent_destroy = false\s+\}/)
  } finally { rmSync(rootPath, { recursive: true }) }
})

test("prevent_destroy blocks direct removal until the guarded override is present", () => {
  const rootPath = mkdtempSync(join(tmpdir(), "alarm-prevent-destroy-"))
  try {
    writeFileSync(join(rootPath, "main.tf"), `
variable "enabled" { type = bool }
resource "terraform_data" "alarm" {
  for_each = var.enabled ? { one = true } : {}
  input    = each.key
  lifecycle { prevent_destroy = true }
}
`)
    const variables = join(rootPath, "terraform.tfvars")
    writeFileSync(variables, "enabled = true\n")
    const init = spawnSync("terraform", [`-chdir=${rootPath}`, "init", "-backend=false", "-input=false"], { encoding: "utf8" })
    assert.equal(init.status, 0, init.stderr || init.stdout)
    const apply = spawnSync("terraform", [`-chdir=${rootPath}`, "apply", "-auto-approve", "-input=false"], { encoding: "utf8" })
    assert.equal(apply.status, 0, apply.stderr || apply.stdout)
    writeFileSync(variables, "enabled = false\n")
    const blocked = spawnSync("terraform", [`-chdir=${rootPath}`, "plan", "-input=false"], { encoding: "utf8" })
    assert.equal(blocked.status, 1)
    assert.match(`${blocked.stdout}\n${blocked.stderr}`, /prevent_destroy/)

    writeFileSync(join(rootPath, "alarm_override.tf"), `
resource "terraform_data" "alarm" {
  lifecycle { prevent_destroy = false }
}
`)
    const guarded = spawnSync("terraform", [`-chdir=${rootPath}`, "plan", "-input=false", "-detailed-exitcode"], { encoding: "utf8" })
    assert.equal(guarded.status, 2, guarded.stderr || guarded.stdout)
    assert.match(guarded.stdout, /1 to destroy/)
  } finally { rmSync(rootPath, { recursive: true }) }
})

test("the guarded workflow enumerates every Terraform alarm key", () => {
  const source = readFileSync("infra/aws/account-security/main.tf", "utf8")
  for (const key of learningLabAlarmKeys) assert.match(source, new RegExp(`\\b${key}\\s*=\\s*\\{`))
  assert.equal(learningLabAlarmKeys.length, 12)
})
