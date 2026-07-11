import { ConvexHttpClient } from "convex/browser"
import { readFile } from "node:fs/promises"
import { hostname } from "node:os"
import { api } from "../convex/_generated/api.js"

const runnerSecret = process.env.RUNNER_SHARED_SECRET
if (!runnerSecret) throw new Error("RUNNER_SHARED_SECRET is required")
import { AwsEcsFargateRunner } from "./aws-ecs-fargate-runner.mjs"
import { cleanupCancelledStartup } from "./startup-cancellation.mjs"

const mode = "aws-ecs-fargate"
const once = process.argv.includes("--once")
const pollMs = Number(process.env.AWS_RUNNER_POLL_MS ?? 3000)
const runnerHostname = hostname()
const runnerId =
  process.env.AWS_RUNNER_ID ?? `aws-dispatcher:${runnerHostname}:${process.pid}`

async function readConvexUrl() {
  if (process.env.CONVEX_URL) return process.env.CONVEX_URL
  if (process.env.VITE_CONVEX_URL) return process.env.VITE_CONVEX_URL

  try {
    const contents = await readFile(new URL("../.env.local", import.meta.url), "utf8")
    const line = contents
      .split(/\r?\n/)
      .find((entry) => entry.startsWith("VITE_CONVEX_URL="))
    return line?.split("=").slice(1).join("=").trim()
  } catch {
    return undefined
  }
}

async function sendHeartbeat(client) {
  await client.mutation(api.runners.heartbeat, {
    runner: mode,
    runnerId,
    pollMs,
    pid: process.pid,
    hostname: runnerHostname,
  })
}

async function expireSessions(client) {
  const sessions = await client.query(api.sessions.listExpired, { runnerSecret })
  for (const session of sessions) {
    if (session.runner !== mode) continue
    await client.mutation(api.sessions.markExpired, {
      runnerSecret,
      sessionId: session._id,
      reason: "Session TTL expired",
    })
  }
}

async function startSessions(client, runner, convexUrl) {
  const sessions = await client.query(api.sessions.listStartable, {
    runnerSecret,
    runner: mode,
  })
  let startedCount = 0

  for (const session of sessions) {
    if (session.runnerResourceId) continue
    let dispatched = false

    try {
      const startupClaimed = await client.mutation(api.sessions.markStarting, {
        runnerSecret,
        sessionId: session._id,
      })
      if (!startupClaimed) continue
      const lab = await client.query(api.labs.get, { labId: session.labId })
      if (!lab) throw new Error(`Lab not found for session ${session._id}`)

      const result = await runner.start({
        sessionId: session._id,
        labSlug: lab.slug,
        workspaceTemplatePath: lab.templatePath,
        ttlSeconds: session.ttlSeconds,
        expiresAt: session.expiresAt,
        convexUrl,
        runnerSecret,
      })
      dispatched = true
      const metadataAccepted = await client.mutation(api.sessions.updateRunnerMetadata, {
        runnerSecret,
        sessionId: session._id,
        runnerResourceId: result.resourceId,
      })
      if (!metadataAccepted) {
        await cleanupCancelledStartup({
          cleanup: () => runner.stop(session._id),
          markCleaned: (cleanupResult) => client.mutation(api.sessions.markCleaned, {
            runnerSecret,
            sessionId: session._id,
            summary: "AWS startup cancelled and resources cleaned up",
            raw: cleanupResult,
          }),
        })
        dispatched = false
        continue
      }
      startedCount += 1
      console.log(
        `[aws-runner] dispatched session ${session._id} as ${result.resourceId}`,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[aws-runner] session ${session._id} failed`, error)
      if (dispatched) {
        try {
          await runner.stop(session._id)
        } catch (cleanupError) {
          console.error(
            `[aws-runner] rollback failed for ${session._id}`,
            cleanupError,
          )
        }
      }
      await client.mutation(api.sessions.markErrored, {
        runnerSecret,
        sessionId: session._id,
        message,
      })
    }
  }

  return startedCount
}

async function stopSessions(client, runner) {
  const sessions = await client.query(api.sessions.listCleanupNeeded, {
    runnerSecret,
    runner: mode,
  })

  for (const session of sessions) {
    try {
      const result = await runner.stop(session._id)
      await client.mutation(api.sessions.markCleaned, {
        runnerSecret,
        sessionId: session._id,
        summary: "AWS ECS task resources cleaned up",
        raw: result,
      })
      console.log(`[aws-runner] cleaned session ${session._id}`)
    } catch (error) {
      console.error(`[aws-runner] cleanup failed for ${session._id}`, error)
    }
  }
}

async function tick(client, runner, convexUrl) {
  await sendHeartbeat(client)
  await expireSessions(client)
  const startedCount = await startSessions(client, runner, convexUrl)
  await stopSessions(client, runner)
  return startedCount
}

async function main() {
  const convexUrl = await readConvexUrl()
  if (!convexUrl) {
    throw new Error(
      "Set VITE_CONVEX_URL in .env.local or CONVEX_URL in the environment.",
    )
  }

  const client = new ConvexHttpClient(convexUrl)
  const runner = new AwsEcsFargateRunner()

  if (once) {
    const count = await tick(client, runner, convexUrl)
    console.log(`[aws-runner] dispatched ${count} requested session(s)`)
    return
  }

  console.log(`[aws-runner] polling Convex every ${pollMs}ms`)
  while (true) {
    await tick(client, runner, convexUrl)
    await new Promise((resolvePoll) => setTimeout(resolvePoll, pollMs))
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
