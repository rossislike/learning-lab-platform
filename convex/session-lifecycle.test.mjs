import assert from "node:assert/strict"
import test from "node:test"

import {
  canBeginStartup,
  canExpire,
  canMarkCleaned,
  canPublishStartup,
  canRequestStop,
  canUpdateRunnerMetadata,
  canUseWorkspace,
  EXPIRABLE_SESSION_STATUSES,
  isActiveSessionStatus,
  selectExpiredSessions,
} from "./sessionLifecycle.ts"

test("stopping remains active until runner cleanup completes", () => {
  assert.equal(isActiveSessionStatus("stopping"), true)
  assert.equal(isActiveSessionStatus("stopped"), false)
})

test("startup transitions cannot resurrect a stopping session", () => {
  assert.equal(canBeginStartup("requested"), true)
  assert.equal(canBeginStartup("stopping"), false)
  assert.equal(canPublishStartup("starting"), true)
  assert.equal(canPublishStartup("stopping"), false)
  assert.equal(canUpdateRunnerMetadata("running"), true)
  assert.equal(canUpdateRunnerMetadata("stopping"), false)
  assert.equal(canUseWorkspace("running"), true)
  assert.equal(canUseWorkspace("stopping"), false)
})

test("stop and expiry preserve the cleanup lifecycle", () => {
  assert.equal(canRequestStop("running"), true)
  assert.equal(canRequestStop("stopping"), true)
  assert.equal(canRequestStop("stopped"), false)
  assert.equal(canExpire("running"), true)
  assert.equal(canExpire("stopping"), false)
})

test("cleanup only accepts terminal and cleanup-pending states", () => {
  assert.equal(canMarkCleaned("running"), false)
  assert.equal(canMarkCleaned("stopping"), true)
  assert.equal(canMarkCleaned("errored"), true)
  assert.equal(canMarkCleaned("expired"), true)
})

test("expirable statuses are the active ones that canExpire", () => {
  assert.deepEqual(
    [...EXPIRABLE_SESSION_STATUSES].sort(),
    ["checking", "failed", "passed", "requested", "running", "starting"],
  )
})

test("past-TTL selection is not hidden by many ended sessions with older expiresAt", () => {
  const now = 1_000_000
  const ended = Array.from({ length: 150 }, (_, i) => ({
    status: ["stopped", "expired", "errored", "stopping"][i % 4],
    expiresAt: i,
  }))
  const live = { status: "running", expiresAt: now - 1 }
  const notYet = { status: "running", expiresAt: now + 1 }
  // Before the fix a by_expires_at window of 100 contained only ended rows.
  assert.deepEqual(selectExpiredSessions([...ended, live, notYet], now), [live])
  // Sorted oldest expiry first.
  const older = { status: "starting", expiresAt: 5 }
  assert.deepEqual(selectExpiredSessions([live, older], now), [older, live])
})
