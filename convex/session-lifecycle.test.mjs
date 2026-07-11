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
  isActiveSessionStatus,
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
