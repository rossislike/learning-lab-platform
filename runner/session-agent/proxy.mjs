// Reverse proxy from the agent port to a loopback service (OpenVSCode), for
// both plain HTTP requests and WebSocket upgrades. No dependencies.

import { request as httpRequest } from "node:http"
import { connect } from "node:net"

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])
const UPGRADE_CONNECT_TIMEOUT_MS = 10_000

/** Header names listed in the request's own Connection header (RFC 7230 §6.1). */
function connectionTokens(headers) {
  const raw = headers.connection
  const values = Array.isArray(raw) ? raw : raw ? [raw] : []
  return new Set(values.flatMap((value) => value.split(",")).map((token) => token.trim().toLowerCase()).filter(Boolean))
}

function forwardedHeaders(req, { host, port, keepUpgrade = false }) {
  const named = connectionTokens(req.headers)
  const headers = {}
  for (const [name, value] of Object.entries(req.headers)) {
    const upgradeHeader = keepUpgrade && (name === "connection" || name === "upgrade")
    if (!upgradeHeader && (HOP_BY_HOP.has(name) || named.has(name))) continue
    headers[name] = value
  }
  headers.host = `${host}:${port}`
  return headers
}

export function proxyHttp(req, res, { host = "127.0.0.1", port, timeoutMs = 60_000 }) {
  const headers = forwardedHeaders(req, { host, port })
  const upstream = httpRequest(
    { host, port, method: req.method, path: req.url, headers, timeout: timeoutMs },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
      upstreamRes.pipe(res)
    },
  )
  upstream.on("timeout", () => upstream.destroy(new Error("upstream timeout")))
  upstream.on("error", (error) => {
    if (res.headersSent) return res.destroy()
    res.writeHead(502, { "content-type": "text/plain" })
    res.end(`upstream unavailable: ${error.message}`)
  })
  req.pipe(upstream)
}

export function proxyUpgrade(req, socket, head, { host = "127.0.0.1", port, connectTimeoutMs = UPGRADE_CONNECT_TIMEOUT_MS }) {
  let connected = false
  const upstream = connect(port, host, () => {
    connected = true
    clearTimeout(connectTimer)
    const headers = forwardedHeaders(req, { host, port, keepUpgrade: true })
    const lines = [`${req.method} ${req.url} HTTP/1.1`]
    for (const [name, value] of Object.entries(headers)) {
      const values = Array.isArray(value) ? value : [value]
      for (const item of values) lines.push(`${name}: ${item}`)
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`)
    if (head && head.length > 0) upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
  const teardown = () => {
    upstream.destroy()
    if (!connected && !socket.destroyed) {
      socket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
    }
    socket.destroy()
  }
  const connectTimer = setTimeout(teardown, connectTimeoutMs)
  connectTimer.unref?.()
  upstream.on("error", teardown)
  socket.on("error", teardown)
  upstream.on("close", () => {
    clearTimeout(connectTimer)
    socket.destroy()
  })
  socket.on("close", () => {
    clearTimeout(connectTimer)
    upstream.destroy()
  })
}
