#!/usr/bin/env node
// Gateway entry point. Environment:
//   CONVEX_URL, RUNNER_SHARED_SECRET
//   GATEWAY_PORT (8080), GATEWAY_HOST_SUFFIX (e.g. lab.localhost or dev.example.com)
//   GATEWAY_APP_ORIGIN    exact origin of the frontend (bootstrap + WS origin checks)
//   GATEWAY_SECURE_COOKIES  "false" for plain-http local development (cookie "llp" instead of "__Host-llp")
//   GATEWAY_DEV_PAGE      "true" to serve /__llp/dev on workspace hosts
//   GATEWAY_APP_UPSTREAM  optional host:port to proxy non-endpoint hosts to (the Vite dev server)
//   GATEWAY_KEEPALIVE_TIMEOUT_MS  HTTP keep-alive timeout (default 65000). Behind a load
//                         balancer it must exceed the LB idle timeout (dev: 3605000 > ALB 3600 s).

import { createConvexHttp } from "../shared/convex-http.mjs"
import { createGateway } from "./gateway.mjs"

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

function parseUpstream(value) {
  if (!value) return undefined
  const [host, port] = value.split(":")
  if (!host || !Number(port)) throw new Error("GATEWAY_APP_UPSTREAM must be host:port")
  return { host, port: Number(port) }
}

async function main() {
  const port = Number(process.env.GATEWAY_PORT ?? 8080)
  const config = {
    hostSuffix: required("GATEWAY_HOST_SUFFIX"),
    appOrigin: required("GATEWAY_APP_ORIGIN"),
    secureCookies: process.env.GATEWAY_SECURE_COOKIES !== "false",
    devPage: process.env.GATEWAY_DEV_PAGE === "true",
    appUpstream: parseUpstream(process.env.GATEWAY_APP_UPSTREAM),
  }
  const convex = createConvexHttp({ convexUrl: required("CONVEX_URL"), runnerSecret: required("RUNNER_SHARED_SECRET") })
  delete process.env.RUNNER_SHARED_SECRET
  const gateway = createGateway({ convex, config, logger })
  const keepAliveTimeout = Number(process.env.GATEWAY_KEEPALIVE_TIMEOUT_MS ?? 65_000)
  if (!Number.isInteger(keepAliveTimeout) || keepAliveTimeout < 1000) throw new Error("GATEWAY_KEEPALIVE_TIMEOUT_MS must be an integer >= 1000")
  // headersTimeout stays at the gateway's 30 s: since Node 18 it is measured
  // from the first byte of each request, so idle keep-alive connections are
  // not cut by it (the old "headersTimeout > keepAliveTimeout" advice predates
  // that), and a long value would only weaken slow-header protection.
  gateway.server.keepAliveTimeout = keepAliveTimeout
  await new Promise((resolve, reject) => {
    gateway.server.once("error", reject)
    gateway.server.listen(port, "0.0.0.0", () => resolve())
  })
  logger.info(
    `[gateway] listening on :${port}; hosts ws-*/pv-*.${config.hostSuffix}; app origin ${config.appOrigin}; cookie ${gateway.cookieName}${config.appUpstream ? `; app upstream ${config.appUpstream.host}:${config.appUpstream.port}` : ""}`,
  )
  // Kubernetes runs the Deployment's preStop sleep before SIGTERM, so by now
  // the load balancer has stopped sending new requests; close and exit
  // within 3 s, well inside terminationGracePeriodSeconds.
  const stop = (signal) => {
    logger.info(`[gateway] ${signal}; closing`)
    gateway.server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000).unref()
  }
  process.on("SIGTERM", () => stop("SIGTERM"))
  process.on("SIGINT", () => stop("SIGINT"))
}

main().catch((error) => {
  logger.error(`[gateway] fatal: ${error.stack ?? error}`)
  process.exit(1)
})
