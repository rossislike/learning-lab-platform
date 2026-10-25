// Reverse proxy for HTTP requests and WebSocket upgrades with header hooks,
// used by the gateway. (The session agent keeps its own smaller copy so the
// session image stays self-contained.)

import { request as httpRequest } from "node:http"
import { connect } from "node:net"

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
])

function connectionTokens(headers) {
  return String(headers.connection ?? "")
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean)
}

/** Copies request headers minus hop-by-hop ones, then applies `rewrite`. */
function outboundHeaders(req, { host, port, rewrite }) {
  const headers = {}
  const dynamicHop = new Set(connectionTokens(req.headers))
  for (const [name, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(name) || dynamicHop.has(name)) continue
    headers[name] = value
  }
  headers.host = `${host}:${port}`
  return rewrite ? rewrite(headers) ?? headers : headers
}

export function proxyHttp(req, res, { host = "127.0.0.1", port, timeoutMs = 120_000, rewriteRequestHeaders, rewriteResponseHeaders }) {
  const headers = outboundHeaders(req, { host, port, rewrite: rewriteRequestHeaders })
  const upstream = httpRequest({ host, port, method: req.method, path: req.url, headers, timeout: timeoutMs }, (upstreamRes) => {
    const responseHeaders = { ...upstreamRes.headers }
    const final = rewriteResponseHeaders ? rewriteResponseHeaders(responseHeaders) ?? responseHeaders : responseHeaders
    res.writeHead(upstreamRes.statusCode ?? 502, final)
    upstreamRes.pipe(res)
  })
  upstream.on("timeout", () => upstream.destroy(new Error("upstream timeout")))
  upstream.on("error", (error) => {
    if (res.headersSent) return res.destroy()
    res.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" })
    res.end(JSON.stringify({ error: "upstream unavailable", detail: error.code ?? error.message }))
  })
  req.pipe(upstream)
}

export function proxyUpgrade(req, socket, head, { host = "127.0.0.1", port, connectTimeoutMs = 10_000, rewriteRequestHeaders }) {
  const headers = outboundHeaders(req, { host, port, rewrite: rewriteRequestHeaders })
  // Upgrade semantics must survive the hop-by-hop filtering.
  headers.connection = "Upgrade"
  headers.upgrade = req.headers.upgrade
  const upstream = connect(port, host)
  const timer = setTimeout(() => upstream.destroy(new Error("upstream connect timeout")), connectTimeoutMs)
  const teardown = () => {
    clearTimeout(timer)
    upstream.destroy()
    socket.destroy()
  }
  upstream.once("connect", () => {
    clearTimeout(timer)
    const lines = [`${req.method} ${req.url} HTTP/1.1`]
    for (const [name, value] of Object.entries(headers)) {
      for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`)
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`)
    if (head && head.length > 0) upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
  let piped = false
  upstream.once("connect", () => {
    piped = true
  })
  upstream.on("error", () => {
    if (!piped && !socket.destroyed && socket.writable) {
      socket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
    }
    teardown()
  })
  socket.on("error", teardown)
  upstream.on("close", () => socket.destroy())
  socket.on("close", () => upstream.destroy())
}
