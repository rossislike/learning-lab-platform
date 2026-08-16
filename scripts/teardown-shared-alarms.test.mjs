import assert from "node:assert/strict"
import test from "node:test"

import { runSharedAlarmTeardown } from "./teardown-shared-alarms.mjs"

const account = "442359104502"
const args = [`--account=${account}`, `--confirm=destroy shared learning-lab alarms in ${account}`]

function dependencies(overrides = {}) {
  return {
    execute: (command, commandArgs) => {
      if (command === "aws" && commandArgs[0] === "sts") return { status: 0, stdout: `${account}\n` }
      return { status: 0, stdout: "" }
    },
    loadBackendRegistry: () => ({ accountId: account }),
    acquireOperationLock: () => ({ ok: true }),
    verifyOperationLock: () => true,
    releaseOperationLock: () => true,
    reconcileSharedAlarms: () => 0,
    ...overrides,
  }
}

test("rejects the wrong account and confirmation", () => {
  assert.equal(runSharedAlarmTeardown(args, dependencies({
    execute: () => ({ status: 0, stdout: "111111111111\n" }),
  })), 1)
  assert.equal(runSharedAlarmTeardown([`--account=${account}`, "--confirm=wrong"], dependencies()), 1)
})

test("runs alarm removal while holding the shared operation lock", () => {
  const order = []
  const status = runSharedAlarmTeardown(args, dependencies({
    acquireOperationLock: () => { order.push("lock"); return { ok: true } },
    reconcileSharedAlarms: ({ enabled }) => { order.push(`alarms:${enabled}`); return 0 },
    releaseOperationLock: () => { order.push("unlock"); return true },
  }))
  assert.equal(status, 0)
  assert.deepEqual(order, ["lock", "alarms:false", "unlock"])
})

test("blocks when another hosted operation owns the lock", () => {
  let reconciled = false
  const status = runSharedAlarmTeardown(args, dependencies({
    acquireOperationLock: () => ({ ok: false, error: "already locked" }),
    reconcileSharedAlarms: () => { reconciled = true; return 0 },
  }))
  assert.equal(status, 1)
  assert.equal(reconciled, false)
})

test("fails when lock release cannot prove ownership", () => {
  assert.equal(runSharedAlarmTeardown(args, dependencies({ releaseOperationLock: () => false })), 1)
})
