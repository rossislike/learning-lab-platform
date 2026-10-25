#!/usr/bin/env node
// Dispatcher entry point. Environment:
//   CONVEX_URL, RUNNER_SHARED_SECRET      Convex control plane
//   SESSIONS_NAMESPACE                     pod namespace (default sessions)
//   SESSION_IMAGE                          session-workspace image
//   SESSION_IMAGE_PULL_POLICY              default IfNotPresent
//   BUNDLE_MODE=hostPath                   local: scenarios mounted on the node
//   BUNDLE_HOST_ROOT=/scenarios            node path of the scenarios/ directory
//   GATEWAY_HOST_SUFFIX, GATEWAY_PUBLIC_SCHEME, GATEWAY_PUBLIC_PORT
//   DISPATCHER_POLL_MS (3000), DISPATCHER_STARTUP_TIMEOUT_MS (600000)
//   KUBERNETES_MODE auto|in-cluster|kubeconfig

import { createConvexHttp } from "../shared/convex-http.mjs"
import { createDispatcher } from "./dispatcher.mjs"
import { createKubernetesClient } from "./k8s.mjs"

const logger = {
  info: (message) => console.log(`${new Date().toISOString()} INFO ${message}`),
  warn: (message) => console.log(`${new Date().toISOString()} WARN ${message}`),
  error: (message) => console.error(`${new Date().toISOString()} ERROR ${message}`),
}

function required(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

async function main() {
  const namespace = process.env.SESSIONS_NAMESPACE ?? "sessions"
  const config = {
    namespace,
    image: process.env.SESSION_IMAGE ?? "learning-lab/session-workspace:dev",
    imagePullPolicy: process.env.SESSION_IMAGE_PULL_POLICY ?? "IfNotPresent",
    agentPort: Number(process.env.AGENT_PORT ?? 7000),
    convexUrl: required("CONVEX_URL"),
    bundle:
      (process.env.BUNDLE_MODE ?? "hostPath") === "hostPath"
        ? { mode: "hostPath", hostRoot: process.env.BUNDLE_HOST_ROOT ?? "/scenarios" }
        : { mode: process.env.BUNDLE_MODE },
    hostSuffix: required("GATEWAY_HOST_SUFFIX"),
    publicScheme: process.env.GATEWAY_PUBLIC_SCHEME ?? "http",
    publicPort: Number(process.env.GATEWAY_PUBLIC_PORT ?? 0) || undefined,
    pollMs: Number(process.env.DISPATCHER_POLL_MS ?? 3000),
    startupTimeoutMs: Number(process.env.DISPATCHER_STARTUP_TIMEOUT_MS ?? 600_000),
  }
  const convex = createConvexHttp({ convexUrl: config.convexUrl, runnerSecret: required("RUNNER_SHARED_SECRET") })
  delete process.env.RUNNER_SHARED_SECRET
  const k8s = await createKubernetesClient({ mode: process.env.KUBERNETES_MODE ?? "auto", namespace })
  logger.info(`[dispatcher] kubernetes ${k8s.server}, namespace ${namespace}`)

  const dispatcher = createDispatcher({ convex, k8s, config, logger })
  if (process.argv.includes("--once")) {
    const result = await dispatcher.tick()
    logger.info(`[dispatcher] once: ${JSON.stringify({ ...result, ...dispatcher.stats })}`)
    return
  }
  const controller = new AbortController()
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      logger.info(`[dispatcher] ${signal}; stopping`)
      controller.abort()
    })
  }
  await dispatcher.run(controller.signal)
}

main().catch((error) => {
  logger.error(`[dispatcher] fatal: ${error.stack ?? error}`)
  process.exit(1)
})
