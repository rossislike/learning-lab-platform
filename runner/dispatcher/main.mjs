#!/usr/bin/env node
// Dispatcher entry point. Environment:
//   CONVEX_URL, RUNNER_SHARED_SECRET      Convex control plane
//   SESSIONS_NAMESPACE                     pod namespace (default sessions)
//   SESSION_IMAGE                          session-workspace image
//   SESSION_IMAGE_PULL_POLICY              default IfNotPresent
//   BUNDLE_MODE=hostPath|s3                local: scenarios mounted on the node; dev: approved bundles in S3
//   BUNDLE_HOST_ROOT=/scenarios            hostPath: node path of the scenarios/ directory
//   BUNDLE_S3_BUCKET, AWS_REGION           s3: bucket of the approved bundles (presigned with Pod Identity creds)
//   BUNDLE_INIT_IMAGE                      s3: image for the download init container (default: the session image)
//   GATEWAY_HOST_SUFFIX, GATEWAY_PUBLIC_SCHEME, GATEWAY_PUBLIC_PORT
//   DISPATCHER_POLL_MS (3000), DISPATCHER_STARTUP_TIMEOUT_MS (600000)
//   KUBERNETES_MODE auto|in-cluster|kubeconfig
//   SESSION_NODE_ARCH (unset = any)        pin session pods to kubernetes.io/arch (dev: amd64, the only image arch CI builds)
//   METRICS_NAMESPACE (unset = off)         dev: CloudWatch namespace for Heartbeat/ActiveSessions/LaunchFailures/LostPods/PodsLaunched
//   METRICS_ENVIRONMENT                     Environment dimension (required with METRICS_NAMESPACE); AWS_REGION; credentials via Pod Identity

import { createCredentialProvider, presignS3GetObject } from "../shared/aws-sigv4.mjs"
import { createMetricsPublisher } from "../shared/aws-sigv4-request.mjs"
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

function bundleConfig() {
  const mode = process.env.BUNDLE_MODE ?? "hostPath"
  if (mode === "hostPath") return { mode, hostRoot: process.env.BUNDLE_HOST_ROOT ?? "/scenarios" }
  if (mode === "s3") {
    return {
      mode,
      bucket: required("BUNDLE_S3_BUCKET"),
      region: required("AWS_REGION"),
      ...(process.env.BUNDLE_INIT_IMAGE ? { initImage: process.env.BUNDLE_INIT_IMAGE } : {}),
    }
  }
  throw new Error(`BUNDLE_MODE must be hostPath or s3 (got ${mode})`)
}

const PRESIGN_SECONDS = 900

function createBundlePresigner(bundle) {
  if (bundle.mode !== "s3") return undefined
  // Refresh credentials while they still outlive a fresh presign by 5 min.
  const getCredentials = createCredentialProvider({ refreshMarginMs: (PRESIGN_SECONDS + 5 * 60) * 1000 })
  return async ({ key }) =>
    presignS3GetObject({ bucket: bundle.bucket, region: bundle.region, key, expiresSeconds: PRESIGN_SECONDS, credentials: await getCredentials() })
}

function createMetrics(logger) {
  const namespace = process.env.METRICS_NAMESPACE
  if (!namespace) return undefined
  return createMetricsPublisher({
    region: required("AWS_REGION"),
    namespace,
    dimensions: { Environment: required("METRICS_ENVIRONMENT") },
    getCredentials: createCredentialProvider(),
    intervalMs: Number(process.env.METRICS_INTERVAL_MS ?? 60_000),
    logger,
  })
}

async function main() {
  const namespace = process.env.SESSIONS_NAMESPACE ?? "sessions"
  const config = {
    namespace,
    image: process.env.SESSION_IMAGE ?? "learning-lab/session-workspace:dev",
    imagePullPolicy: process.env.SESSION_IMAGE_PULL_POLICY ?? "IfNotPresent",
    agentPort: Number(process.env.AGENT_PORT ?? 7000),
    convexUrl: required("CONVEX_URL"),
    bundle: bundleConfig(),
    hostSuffix: required("GATEWAY_HOST_SUFFIX"),
    publicScheme: process.env.GATEWAY_PUBLIC_SCHEME ?? "http",
    publicPort: Number(process.env.GATEWAY_PUBLIC_PORT ?? 0) || undefined,
    pollMs: Number(process.env.DISPATCHER_POLL_MS ?? 3000),
    startupTimeoutMs: Number(process.env.DISPATCHER_STARTUP_TIMEOUT_MS ?? 600_000),
    ...(process.env.SESSION_NODE_ARCH ? { nodeArch: process.env.SESSION_NODE_ARCH } : {}),
  }
  const convex = createConvexHttp({ convexUrl: config.convexUrl, runnerSecret: required("RUNNER_SHARED_SECRET") })
  delete process.env.RUNNER_SHARED_SECRET
  const k8s = await createKubernetesClient({ mode: process.env.KUBERNETES_MODE ?? "auto", namespace })
  logger.info(`[dispatcher] kubernetes ${k8s.server}, namespace ${namespace}`)

  const metrics = createMetrics(logger)
  if (metrics) logger.info(`[dispatcher] publishing CloudWatch metrics to ${process.env.METRICS_NAMESPACE}`)
  const dispatcher = createDispatcher({ convex, k8s, config, logger, presignBundle: createBundlePresigner(config.bundle), metrics })
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
