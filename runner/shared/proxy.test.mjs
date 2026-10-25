import assert from "node:assert/strict"
import { createServer, request as httpRequest } from "node:http"
import { connect } from "node:net"
import test from "node:test"
import { proxyHttp, proxyUpgrade } from "./proxy.mjs"

async function listen(server) {
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  return server.address().port
}

function call(port, path, { method = "GET", headers = {} } = {}) {
  return new Promise((resolveCall, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let text = ""
      res.on("data", (chunk) => (text += chunk))
      res.on("end", () => resolveCall({ status: res.statusCode, headers: res.headers, text }))
    })
    req.on("error", reject)
    req.end()
  })
}

test("proxyHttp strips hop-by-hop and Connection-listed headers, sets Host, applies rewrites", async () => {
  const upstream = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json", "x-upstream": "1" })
    res.end(JSON.stringify({ url: req.url, headers: req.headers }))
  })
  const upstreamPort = await listen(upstream)
  const gateway = createServer((req, res) =>
    proxyHttp(req, res, {
      port: upstreamPort,
      rewriteRequestHeaders: (headers) => {
        headers["x-added"] = "yes"
        return headers
      },
      rewriteResponseHeaders: (headers) => {
        delete headers["x-upstream"]
        headers["x-gateway"] = "1"
        return headers
      },
    }),
  )
  const gatewayPort = await listen(gateway)
  try {
    const seen = await call(gatewayPort, "/a?b=1", {
      headers: {
        connection: "close, x-custom-hop",
        "x-custom-hop": "drop-me",
        "keep-alive": "timeout=5",
        te: "trailers",
        "proxy-authorization": "Basic x",
        "x-keep": "1",
      },
    })
    assert.equal(seen.status, 200)
    const body = JSON.parse(seen.text)
    assert.equal(body.url, "/a?b=1")
    assert.equal(body.headers.host, `127.0.0.1:${upstreamPort}`)
    assert.equal(body.headers["x-keep"], "1")
    assert.equal(body.headers["x-added"], "yes")
    for (const name of ["x-custom-hop", "keep-alive", "te", "proxy-authorization", "upgrade"]) {
      assert.equal(body.headers[name], undefined, `${name} must not be forwarded`)
    }
    assert.equal(seen.headers["x-upstream"], undefined)
    assert.equal(seen.headers["x-gateway"], "1")
  } finally {
    await new Promise((r) => gateway.close(r))
    await new Promise((r) => upstream.close(r))
  }
})

test("proxyHttp answers 502 when the upstream is unreachable before headers were sent", async () => {
  const dead = createServer()
  const deadPort = await listen(dead)
  await new Promise((r) => dead.close(r)) // port is now closed
  const gateway = createServer((req, res) => proxyHttp(req, res, { port: deadPort }))
  const gatewayPort = await listen(gateway)
  try {
    const response = await call(gatewayPort, "/")
    assert.equal(response.status, 502)
    assert.deepEqual(JSON.parse(response.text), { error: "upstream unavailable", detail: "ECONNREFUSED" })
    assert.equal(response.headers["cache-control"], "no-store")
  } finally {
    await new Promise((r) => gateway.close(r))
  }
})

test("proxyUpgrade reconstructs the request with array headers, Upgrade semantics and the head bytes", async () => {
  let received = ""
  const upstream = createServer()
  upstream.on("upgrade", (req, socket, head) => {
    received = `${req.method} ${req.url}\n${req.rawHeaders.join("|")}\nhead=${head.toString()}`
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
    socket.on("data", (chunk) => socket.write(`echo:${chunk}`))
    socket.on("end", () => socket.end()) // like a real WebSocket server, close when the peer does
  })
  const upstreamPort = await listen(upstream)
  const gateway = createServer((_req, res) => res.end())
  gateway.on("upgrade", (req, socket, head) =>
    proxyUpgrade(req, socket, head, {
      port: upstreamPort,
      rewriteRequestHeaders: (headers) => {
        headers["x-multi"] = ["one", "two"]
        delete headers.cookie
        return headers
      },
    }),
  )
  const gatewayPort = await listen(gateway)
  try {
    const output = await new Promise((resolveOut, reject) => {
      const socket = connect(gatewayPort, "127.0.0.1")
      let data = ""
      socket.on("connect", () => {
        socket.write(
          "GET /pty?id=1 HTTP/1.1\r\nHost: ws-x.lab.localhost\r\nCookie: llp=secret\r\nConnection: Upgrade, X-Hop\r\nX-Hop: drop\r\n" +
            "Upgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\nEARLY",
        )
      })
      socket.on("data", (chunk) => {
        data += chunk
        if (data.includes("echo:")) socket.end()
        else if (data.includes("101")) socket.write("ping")
      })
      socket.on("close", () => resolveOut(data))
      socket.on("error", reject)
    })
    assert.match(output, /^HTTP\/1\.1 101/)
    assert.match(output, /echo:ping/)
    assert.match(received, /^GET \/pty\?id=1\n/)
    assert.match(received, /x-multi\|one\|x-multi\|two/, "array headers become repeated lines")
    assert.match(received, /connection\|Upgrade\|upgrade\|websocket/i)
    assert.doesNotMatch(received, /cookie/i)
    assert.doesNotMatch(received, /x-hop/i)
    assert.match(received, /host\|127\.0\.0\.1:\d+/)
    assert.match(received, /head=EARLY$/, "bytes after the request head reach the upstream")
  } finally {
    await new Promise((r) => gateway.close(r))
    await new Promise((r) => upstream.close(r))
  }
})

test("proxyUpgrade answers 502 when the upstream refuses the connection", async () => {
  const dead = createServer()
  const deadPort = await listen(dead)
  await new Promise((r) => dead.close(r))
  const gateway = createServer((_req, res) => res.end())
  gateway.on("upgrade", (req, socket, head) => proxyUpgrade(req, socket, head, { port: deadPort }))
  const gatewayPort = await listen(gateway)
  try {
    const output = await new Promise((resolveOut, reject) => {
      const socket = connect(gatewayPort, "127.0.0.1")
      let data = ""
      socket.on("connect", () => socket.write("GET /ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"))
      socket.on("data", (chunk) => (data += chunk))
      socket.on("close", () => resolveOut(data))
      socket.on("error", reject)
    })
    assert.match(output, /^HTTP\/1\.1 502 Bad Gateway/)
  } finally {
    await new Promise((r) => gateway.close(r))
  }
})
