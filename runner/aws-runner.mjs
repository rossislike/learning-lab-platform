import { ConvexHttpClient } from "convex/browser"
import { readFile } from "node:fs/promises"
import { hostname } from "node:os"
import { fileURLToPath } from "node:url"
import { api } from "../convex/_generated/api.js"

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

async function expireSessions(client, runnerSecret) {
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

export function hostedDispatchInput(session, convexUrl, runnerSecret) {
  const scenario = session.hostedScenario
  if (!scenario) {
    throw new Error(`Hosted session ${session._id} is missing its approved scenario snapshot`)
  }
  return {
    sessionId: session._id,
    scenarioApprovalId: scenario.approvalId,
    labSlug: scenario.slug,
    hostedEnvironment: scenario.environment,
    artifactKey: scenario.artifactKey,
    artifactSha256: scenario.artifactSha256,
    artifactSizeBytes: scenario.artifactSizeBytes,
    manifestKey: scenario.manifestKey,
    manifestSha256: scenario.manifestSha256,
    sourceManifestSha256: scenario.sourceManifestSha256,
    runtime: scenario.runtime,
    schemaVersion: scenario.schemaVersion,
    ttlSeconds: session.ttlSeconds,
    expiresAt: session.expiresAt,
    convexUrl,
    runnerSecret,
  }
}

export async function startSessions(client, runner, convexUrl, runnerSecret) {
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
      const result = await runner.start(
        hostedDispatchInput(session, convexUrl, runnerSecret),
      )
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

async function stopSessions(client, runner, runnerSecret) {
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

async function tick(client, runner, convexUrl, runnerSecret) {
  await sendHeartbeat(client)
  await expireSessions(client, runnerSecret)
  const startedCount = await startSessions(client, runner, convexUrl, runnerSecret)
  await stopSessions(client, runner, runnerSecret)
  return startedCount
}

async function main() {
  const runnerSecret = process.env.RUNNER_SHARED_SECRET
  if (!runnerSecret) throw new Error("RUNNER_SHARED_SECRET is required")
  const convexUrl = await readConvexUrl()
  if (!convexUrl) {
    throw new Error(
      "Set VITE_CONVEX_URL in .env.local or CONVEX_URL in the environment.",
    )
  }

  const client = new ConvexHttpClient(convexUrl)
  const runner = new AwsEcsFargateRunner()

  if (once) {
    const count = await tick(client, runner, convexUrl, runnerSecret)
    console.log(`[aws-runner] dispatched ${count} requested session(s)`)
    return
  }

  console.log(`[aws-runner] polling Convex every ${pollMs}ms`)
  while (true) {
    await tick(client, runner, convexUrl, runnerSecret)
    await new Promise((resolvePoll) => setTimeout(resolvePoll, pollMs))
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
