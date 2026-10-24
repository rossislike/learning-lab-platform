#!/usr/bin/env node
// Entry point for the session agent inside a session pod (or `docker run`).
//
// Environment:
//   LAB_SCENARIO_DIR   bundle root containing manifest.json   (default /scenario)
//   AGENT_PORT         listen port                            (default 7000)
//   OPENVSCODE_SERVER_BIN  path to openvscode-server          (default on PATH)
//   EDITOR_PORT        loopback port for OpenVSCode           (default 3000)
//   CONVEX_URL, SESSION_ID, SESSION_TOKEN   optional; enable step-result reporting
//   SCRIPT_TIMEOUT_MS  per-script timeout                     (default 600000)
//   AGENT_ALLOWED_WORKSPACE_ROOTS  where workspace.cwd may live (default /workspace,/home,/tmp)
//   AGENT_LEARNER_ENV_PASSTHROUGH  extra env names forwarded to learner shells (comma list)
//
// The workspace directory comes from the manifest (workspace.cwd). The
// development page (GET /, /terminal.html) is served only when SESSION_TOKEN
// is absent, i.e. when the agent runs standalone rather than under the
// dispatcher.

import { loadPtyBackend } from "./pty.mjs"
import { createReporter } from "./reporter.mjs"
import { loadScenario } from "./scenario.mjs"
import { createAgent } from "./server.mjs"

const logger = {
  info: (message) => console.log(`${new Date().toISOString()} INFO ${message}`),
  warn: (message) => console.log(`${new Date().toISOString()} WARN ${message}`),
  error: (message) => console.error(`${new Date().toISOString()} ERROR ${message}`),
}

async function main() {
  const scenarioDir = process.env.LAB_SCENARIO_DIR ?? "/scenario"
  const port = Number(process.env.AGENT_PORT ?? 7000)
  const editorPort = Number(process.env.EDITOR_PORT ?? 3000)
  const scriptTimeoutMs = Number(process.env.SCRIPT_TIMEOUT_MS ?? 600_000)

  const scenario = await loadScenario(scenarioDir)
  const backend = await loadPtyBackend({ logger })
  const reporter = createReporter({
    convexUrl: process.env.CONVEX_URL,
    sessionId: process.env.SESSION_ID,
    sessionToken: process.env.SESSION_TOKEN,
    logger,
  })
  const devPage = !process.env.SESSION_TOKEN
  // Learner shells get an allowlisted environment (scenario.mjs). Dropping the
  // token here keeps it out of anything else this process spawns, but note
  // /proc/<agent pid>/environ still holds the initial environment and the
  // learner shares our uid — see runner/README.md ("Agent token exposure").
  delete process.env.SESSION_TOKEN

  const agent = createAgent({ scenario, backend, reporter, logger, editorPort, scriptTimeoutMs, devPage })
  logger.info(`[agent] scenario ${scenario.slug} (${scenario.kind}) cwd ${scenario.cwd} pty ${backend.name}`)

  await new Promise((resolve, reject) => {
    agent.server.once("error", reject)
    agent.server.listen(port, "0.0.0.0", () => {
      agent.server.off("error", reject)
      resolve()
    })
  })
  logger.info(`[agent] listening on :${port}`)

  const stop = (signal) => {
    logger.info(`[agent] ${signal}; shutting down`)
    agent.shutdown()
    setTimeout(() => process.exit(0), 500).unref()
  }
  process.on("SIGTERM", () => stop("SIGTERM"))
  process.on("SIGINT", () => stop("SIGINT"))

  await agent.start()
  logger.info(`[agent] startup complete; phase=${agent.summary().phase} (setup ${agent.summary().setup.status})`)
  await agent.settled()
  logger.info(`[agent] setup ${agent.summary().setup.status}; phase=${agent.summary().phase}`)
}

main().catch((error) => {
  logger.error(`[agent] fatal: ${error.stack ?? error}`)
  process.exit(1)
})
