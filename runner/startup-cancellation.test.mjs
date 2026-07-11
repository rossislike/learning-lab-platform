import assert from "node:assert/strict"
import test from "node:test"

import { cleanupCancelledStartup } from "./startup-cancellation.mjs"

test("cancelled startup cleans resources before publishing cleanup", async () => {
  const calls = []
  const continued = await cleanupCancelledStartup({
    cleanup: async () => {
      calls.push("cleanup")
      return { stoppedCount: 1 }
    },
    markCleaned: async (result) => {
      calls.push(["markCleaned", result])
    },
  })

  assert.equal(continued, false)
  assert.deepEqual(calls, [
    "cleanup",
    ["markCleaned", { stoppedCount: 1 }],
  ])
})

test("cancelled startup does not claim cleanup if resource cleanup fails", async () => {
  let markedCleaned = false

  await assert.rejects(
    cleanupCancelledStartup({
      cleanup: async () => {
        throw new Error("cleanup failed")
      },
      markCleaned: async () => {
        markedCleaned = true
      },
    }),
    /cleanup failed/,
  )
  assert.equal(markedCleaned, false)
})
