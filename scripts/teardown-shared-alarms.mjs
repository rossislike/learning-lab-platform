import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import {
  acquireHostedOperationLock,
  loadAwsTerraformBackendRegistry,
  releaseHostedOperationLock,
  verifyHostedOperationLock,
} from "./aws-terraform-operations.mjs"
import { reconcileSharedAlarms } from "./shared-alarm-lifecycle.mjs"

const knownFlags = new Set(["account", "confirm"])

function execute(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", stdio: options.capture ? "pipe" : "inherit" })
}

function parseFlags(values) {
  const parsed = new Map()
  for (const value of values) {
    const match = /^--([^=]+)=(.*)$/.exec(value)
    if (!match || !knownFlags.has(match[1]) || parsed.has(match[1])) return null
    parsed.set(match[1], match[2])
  }
  return parsed
}

function resultText(result) {
  return result?.status === 0 && typeof result.stdout === "string" ? result.stdout.trim() : null
}

function usage() {
  console.error("usage: npm run infra:teardown:shared-alarms -- --account=<12-digit-id> --confirm=<phrase>")
}

export function runSharedAlarmTeardown(args = process.argv.slice(2), deps = {}) {
  const flags = parseFlags(args)
  if (!flags) { usage(); return 2 }
  const account = flags.get("account")
  if (!/^\d{12}$/.test(account ?? "")) { usage(); return 2 }
  if (flags.get("confirm") !== `destroy shared learning-lab alarms in ${account}`) return 1

  const run = deps.execute ?? execute
  const rootPath = deps.rootPath ?? process.cwd()
  const activeAccount = resultText(run("aws", ["sts", "get-caller-identity", "--query", "Account", "--output", "text"], { capture: true }))
  if (activeAccount !== account) {
    console.error("blocked: active AWS account does not match --account")
    return 1
  }

  let registry
  try {
    registry = (deps.loadBackendRegistry ?? loadAwsTerraformBackendRegistry)(rootPath, deps.fs)
  } catch (error) {
    console.error(`blocked: ${error.message}`)
    return 1
  }
  if (registry.accountId !== account) {
    console.error("blocked: canonical backend account does not match --account")
    return 1
  }

  const acquire = deps.acquireOperationLock ?? acquireHostedOperationLock
  const release = deps.releaseOperationLock ?? releaseHostedOperationLock
  const verify = deps.verifyOperationLock ?? verifyHostedOperationLock
  const lockOptions = { environment: deps.environment ?? process.env }
  const lock = acquire({ ...lockOptions, registry, owner: deps.lockOwner })
  if (!lock.ok) {
    console.error(`blocked: ${lock.error}`)
    return 1
  }

  let status = 1
  try {
    status = (deps.reconcileSharedAlarms ?? reconcileSharedAlarms)({
      account,
      enabled: false,
      execute: run,
      rootPath,
      fs: deps.fs,
      backendRegistry: registry,
      verifyOperationLock: () => verify(lock, lockOptions),
      planId: deps.planId,
      beforeApply: deps.beforeApply,
    })
  } finally {
    if (!release(lock, lockOptions)) {
      console.error("blocked: shared hosted operation lock could not be released safely")
      status = 1
    }
  }
  return status
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = runSharedAlarmTeardown()
