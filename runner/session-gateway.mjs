import { createServer } from "node:http"
import { pathToFileURL } from "node:url"

const defaultHost = "0.0.0.0"
const defaultPort = 8080

function writeJson(response, statusCode, body) {
  const payload = JSON.stringify(body)
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
    "content-type": "application/json; charset=utf-8",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  })
  response.end(payload)
}

export function createSessionGateway() {
  return createServer(handleSessionGatewayRequest)
}

export function handleSessionGatewayRequest(request, response) {
  if (request.method === "GET" && request.url === "/health") {
    writeJson(response, 200, { status: "healthy" })
    return
  }

  writeJson(response, 503, {
    code: "gateway-deployment-pending",
    message: "Authenticated session routing is not enabled.",
  })
}

export async function startSessionGateway({
  host = process.env.SESSION_GATEWAY_HOST ?? defaultHost,
  port = Number(process.env.SESSION_GATEWAY_PORT ?? defaultPort),
} = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("SESSION_GATEWAY_PORT must be an integer from 1 through 65535")
  }

  const server = createSessionGateway()
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, host, resolve)
  })

  const stop = (signal) => {
    console.log(`[session-gateway] received ${signal}, shutting down`)
    server.close((error) => {
      if (error) {
        console.error(error)
        process.exitCode = 1
      }
    })
  }
  process.once("SIGINT", () => stop("SIGINT"))
  process.once("SIGTERM", () => stop("SIGTERM"))

  console.log(`[session-gateway] listening on ${host}:${port}`)
  return server
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : ""
if (import.meta.url === invokedPath) {
  startSessionGateway().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
