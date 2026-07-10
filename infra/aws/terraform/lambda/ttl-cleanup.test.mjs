import assert from "node:assert/strict"
import test from "node:test"
import { handler } from "./ttl-cleanup.mjs"

const now = Date.parse("2026-07-10T12:00:00.000Z")

test("the deployment bundle exports the cleanup handler", async () => {
  const bundle = await import("./index.cjs")
  assert.equal(typeof bundle.handler, "function")
})

function managedTask(taskArn, expiresAt, createdAt = now - 60_000) {
  return {
    taskArn,
    createdAt: new Date(createdAt),
    tags: [
      { key: "learning-lab:managed", value: "true" },
      { key: "learning-lab:expires-at", value: expiresAt },
    ],
  }
}

test("paginates, describes in ECS-sized batches, and stops exact or past expiry", async () => {
  const taskArns = Array.from({ length: 101 }, (_, index) => `task-${index}`)
  const calls = []
  let listPage = 0
  const client = {
    async send(command) {
      calls.push(command)
      if (command.constructor.name === "ListTasksCommand") {
        listPage += 1
        return listPage === 1
          ? { taskArns: taskArns.slice(0, 70), nextToken: "page-2" }
          : { taskArns: taskArns.slice(70) }
      }
      if (command.constructor.name === "DescribeTasksCommand") {
        return {
          tasks: command.input.tasks.map((taskArn) =>
            managedTask(
              taskArn,
              taskArn === "task-100"
                ? "2026-07-10T12:00:01.000Z"
                : "2026-07-10T12:00:00.000Z",
            ),
          ),
        }
      }
      return {}
    },
  }

  const result = await handler(undefined, undefined, {
    client,
    cluster: "cluster-arn",
    now: () => now,
  })

  assert.equal(result.scanned, 101)
  assert.equal(result.stopped.length, 100)
  assert.equal(result.stopped.includes("task-100"), false)
  assert.equal(
    calls.filter((call) => call.constructor.name === "ListTasksCommand").length,
    2,
  )
  assert.deepEqual(
    calls
      .filter((call) => call.constructor.name === "DescribeTasksCommand")
      .map((call) => call.input.tasks.length),
    [100, 1],
  )
})

test("ignores unmanaged tasks and applies a bounded fail-safe to malformed TTL tags", async () => {
  const tasks = [
    managedTask("recent-malformed", "invalid", now - 60_000),
    managedTask("old-malformed", "invalid", now - 9 * 60 * 60 * 1000),
    managedTask("date-only", "2026-07-10", now - 60_000),
    managedTask("noncanonical", "2026-07-10T12:00:00Z", now - 60_000),
    managedTask("rolled-calendar", "2026-02-30T12:00:00.000Z", now - 60_000),
    managedTask("year-only", "9999", now - 60_000),
    managedTask("excessive-year", "9999-01-01T00:00:00.000Z", now - 60_000),
    {
      taskArn: "missing-created-at",
      tags: [
        { key: "learning-lab:managed", value: "true" },
        { key: "learning-lab:expires-at", value: "invalid" },
      ],
    },
    {
      taskArn: "unmanaged",
      createdAt: new Date(now - 24 * 60 * 60 * 1000),
      tags: [{ key: "learning-lab:expires-at", value: "invalid" }],
    },
  ]
  const client = {
    async send(command) {
      if (command.constructor.name === "ListTasksCommand") {
        return { taskArns: tasks.map(({ taskArn }) => taskArn) }
      }
      if (command.constructor.name === "DescribeTasksCommand") return { tasks }
      return {}
    },
  }

  const result = await handler(undefined, undefined, {
    client,
    cluster: "cluster-arn",
    now: () => now,
    maxRuntimeSeconds: 8 * 60 * 60,
  })

  assert.deepEqual(result.stopped, ["old-malformed", "missing-created-at"])
  assert.deepEqual(result.malformed, [
    "recent-malformed",
    "date-only",
    "noncanonical",
    "rolled-calendar",
    "year-only",
    "excessive-year",
  ])
})

test("throws after reporting failures without preventing other cleanup", async () => {
  const tasks = [
    managedTask("stop-fails", "2026-07-10T11:59:00.000Z"),
    managedTask("stop-succeeds", "2026-07-10T11:59:00.000Z"),
  ]
  const calls = []
  const client = {
    async send(command) {
      calls.push(command)
      if (command.constructor.name === "ListTasksCommand") {
        return { taskArns: tasks.map(({ taskArn }) => taskArn) }
      }
      if (command.constructor.name === "DescribeTasksCommand") {
        return { tasks, failures: [{ arn: "missing", reason: "MISSING" }] }
      }
      if (command.input.task === "stop-fails") throw new Error("denied")
      return {}
    },
  }

  await assert.rejects(
    handler(undefined, undefined, {
      client,
      cluster: "cluster-arn",
      now: () => now,
    }),
    /TTL cleanup encountered ECS API failures/,
  )
  assert.equal(
    calls.filter(
      (call) =>
        call.constructor.name === "StopTaskCommand" &&
        call.input.task === "stop-succeeds",
    ).length,
    1,
  )
})
