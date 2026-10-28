import assert from "node:assert/strict"
import test from "node:test"
import { EXPIRES_AT_ANNOTATION, finishedAtOf, reap, selectPodsToReap } from "./reaper.mjs"
import { SESSION_ID_LABEL, SESSION_LABEL, SESSION_LABEL_VALUE } from "./pod-spec.mjs"

const NOW = Date.parse("2026-10-28T12:00:00Z")
const minutesAgo = (minutes) => new Date(NOW - minutes * 60_000).toISOString()

function pod(name, { expiresAt, phase = "Running", finishedAt, createdAt = minutesAgo(30), sessionId = `s-${name}` } = {}) {
  return {
    metadata: {
      name,
      creationTimestamp: createdAt,
      labels: { [SESSION_LABEL]: SESSION_LABEL_VALUE, [SESSION_ID_LABEL]: sessionId },
      annotations: expiresAt ? { [EXPIRES_AT_ANNOTATION]: expiresAt } : {},
    },
    status: {
      phase,
      ...(finishedAt ? { containerStatuses: [{ name: "workspace", state: { terminated: { exitCode: 1, finishedAt } } }] } : {}),
    },
  }
}

test("reaps pods past their expiry (after the grace) and finished pods left behind", () => {
  const pods = [
    pod("live", { expiresAt: minutesAgo(-30) }),
    pod("just-expired", { expiresAt: minutesAgo(5) }),
    pod("long-expired", { expiresAt: minutesAgo(25) }),
    pod("failed-recent", { phase: "Failed", finishedAt: minutesAgo(2) }),
    pod("failed-old", { phase: "Failed", finishedAt: minutesAgo(12) }),
    pod("succeeded-no-status", { phase: "Succeeded", createdAt: minutesAgo(45) }),
    pod("no-expiry-running", {}),
    { metadata: {} },
  ]
  const victims = selectPodsToReap(pods, { now: NOW })
  assert.deepEqual(
    victims.map((victim) => [victim.name, victim.reason]),
    [
      ["long-expired", "expired 25 min ago"],
      ["failed-old", "failed 12 min ago"],
      ["succeeded-no-status", "succeeded 45 min ago"],
    ],
  )
  assert.equal(victims[0].sessionId, "s-long-expired")
})

test("grace periods are configurable", () => {
  const pods = [pod("expired", { expiresAt: minutesAgo(5) }), pod("failed", { phase: "Failed", finishedAt: minutesAgo(2) })]
  assert.equal(selectPodsToReap(pods, { now: NOW }).length, 0)
  assert.equal(selectPodsToReap(pods, { now: NOW, expiredGraceMs: 60_000, finishedGraceMs: 60_000 }).length, 2)
})

test("reap deletes the selection through the client, or only reports in dry-run", async () => {
  const deleted = []
  const k8s = {
    listPods: async (selector) => {
      assert.equal(selector, `${SESSION_LABEL}=${SESSION_LABEL_VALUE}`)
      return [pod("gone", { expiresAt: minutesAgo(60) }), pod("fine", { expiresAt: minutesAgo(-10) })]
    },
    deletePod: async (name) => {
      deleted.push(name)
      return true
    },
  }
  const logs = []
  const logger = { warn: (line) => logs.push(line), info: (line) => logs.push(line) }
  assert.deepEqual(await reap({ k8s, logger, now: NOW, dryRun: true }), { scanned: 2, selected: 1, deleted: 0 })
  assert.deepEqual(deleted, [])
  assert.match(logs[0], /would delete pod gone/)
  assert.deepEqual(await reap({ k8s, logger, now: NOW }), { scanned: 2, selected: 1, deleted: 1 })
  assert.deepEqual(deleted, ["gone"])
})

test("finishedAtOf: latest termination or condition transition, then creation, then now", () => {
  const base = { metadata: { name: "p", creationTimestamp: minutesAgo(30) }, status: { phase: "Failed" } }
  assert.equal(finishedAtOf(base, NOW), NOW - 30 * 60_000)
  assert.equal(
    finishedAtOf({ ...base, status: { phase: "Failed", conditions: [{ type: "Ready", status: "False", lastTransitionTime: minutesAgo(4) }] } }, NOW),
    NOW - 4 * 60_000,
  )
  assert.equal(
    finishedAtOf({
      ...base,
      status: {
        phase: "Failed",
        conditions: [{ type: "Ready", status: "False", lastTransitionTime: minutesAgo(20) }],
        containerStatuses: [{ name: "w", state: { terminated: { exitCode: 1, finishedAt: minutesAgo(7) } } }],
      },
    }, NOW),
    NOW - 7 * 60_000,
  )
  // No usable timestamps at all: treated as finishing now (not reaped this run).
  assert.equal(finishedAtOf({ metadata: { name: "p" }, status: { phase: "Failed" } }, NOW), NOW)
  assert.deepEqual(selectPodsToReap([{ metadata: { name: "p" }, status: { phase: "Failed" } }], { now: NOW }), [])
})
