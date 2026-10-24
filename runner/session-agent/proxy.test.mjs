import assert from "node:assert/strict"
import { once } from "node:events"
import { createServer, request } from "node:http"
import { connect } from "node:net"
import test from "node:test"
import { proxyHttp, proxyUpgrade } from "./proxy.mjs"
import { acceptWebSocket } from "./websocket.mjs"

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  return server.address().port
}

function httpRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", ...options }, (res) => {
      let text = ""
      res.on("data", (chunk) => (text += chunk))
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }))
    })
    req.on("error", reject)
    req.end(body)
  })
}

/** Keep-alive sockets (undici, http.Agent) would otherwise keep close() pending. */
function stop(server) {
  server.closeAllConnections?.()
  return new Promise((resolve) => server.close(resolve))
}

test("proxyHttp forwards requests and strips hop-by-hop headers; 502 when the upstream is down", async () => {
  const seen = []
  const upstream = createServer((req, res) => {
    seen.push(req.headers)
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => {
      res.writeHead(201, { "x-upstream": "yes" })
      res.end(`echo:${req.method}:${req.url}:${body}`)
    })
  })
  const upstreamPort = await listen(upstream)
  const front = createServer((req, res) => proxyHttp(req, res, { port: upstreamPort }))
  const frontPort = await listen(front)
  try {
    // fetch() refuses a Connection header, so use node:http to send one.
    const response = await httpRequest(
      {
        port: frontPort,
        method: "POST",
        path: "/editor/x?y=1",
        headers: { "x-custom": "a", connection: "x-custom, keep-alive", "x-forwarded-for": "1.2.3.4" },
      },
      "hello",
    )
    assert.equal(response.status, 201)
    assert.equal(response.headers["x-upstream"], "yes")
    assert.equal(response.text, "echo:POST:/editor/x?y=1:hello")
    assert.equal(seen[0].host, `127.0.0.1:${upstreamPort}`)
    assert.equal(seen[0]["x-forwarded-for"], "1.2.3.4")
    assert.equal(seen[0]["x-custom"], undefined, "headers named in Connection are dropped")

    await stop(upstream)
    const down = await httpRequest({ port: frontPort, path: "/editor/" })
    assert.equal(down.status, 502)
    assert.match(down.text, /upstream unavailable/)
  } finally {
    await stop(front)
  }
})

test("proxyUpgrade relays a WebSocket to the upstream and fails fast when it is down", async () => {
  const upstream = createServer()
  upstream.on("upgrade", (req, socket, head) => {
    const ws = acceptWebSocket(req, socket, head)
    ws.on("message", (data) => ws.send(`upstream:${data}:${req.url}`))
  })
  const upstreamPort = await listen(upstream)
  const front = createServer()
  front.on("upgrade", (req, socket, head) => proxyUpgrade(req, socket, head, { port: upstreamPort }))
  const frontPort = await listen(front)
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${frontPort}/editor/ws?a=1`)
    await new Promise((resolve, reject) => {
      ws.onopen = resolve
      ws.onerror = () => reject(new Error("relay failed"))
    })
    const reply = new Promise((resolve) => (ws.onmessage = (event) => resolve(event.data)))
    ws.send("ping")
    assert.equal(await reply, "upstream:ping:/editor/ws?a=1")
    ws.close()

    await stop(upstream)
    const socket = connect(frontPort, "127.0.0.1")
    await once(socket, "connect")
    socket.write(
      "GET /editor/ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
    )
    const [data] = await once(socket, "data")
    assert.match(data.toString(), /^HTTP\/1\.1 502/)
    socket.destroy()
  } finally {
    await stop(front)
  }
})
