import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import test from "node:test"
import { acceptWebSocket, isWebSocketUpgrade, rejectUpgrade } from "./websocket.mjs"

async function startEchoServer() {
  const server = createServer((_req, res) => {
    res.writeHead(404)
    res.end()
  })
  const connections = []
  server.on("upgrade", (req, socket, head) => {
    if (!isWebSocketUpgrade(req)) return rejectUpgrade(socket, 400, "Nope")
    const ws = acceptWebSocket(req, socket, head)
    connections.push(ws)
    ws.on("message", (data, isBinary) => ws.send(isBinary ? data : `echo:${data}`))
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address()
  return { server, port, connections, close: () => new Promise((resolve) => server.close(resolve)) }
}

function connect(url) {
  const ws = new WebSocket(url)
  ws.binaryType = "arraybuffer"
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve(ws)
    ws.onerror = () => reject(new Error("connect failed"))
  })
}

function nextMessage(ws) {
  return new Promise((resolve) => {
    ws.onmessage = (event) => resolve(event.data)
  })
}

test("handshake, text and binary echo, large frames", async () => {
  const echo = await startEchoServer()
  try {
    const ws = await connect(`ws://127.0.0.1:${echo.port}/`)
    ws.send("hi")
    assert.equal(await nextMessage(ws), "echo:hi")

    const big = "x".repeat(70_000) // forces the 64-bit length form
    ws.send(big)
    assert.equal(await nextMessage(ws), `echo:${big}`)

    const bytes = new Uint8Array([0, 1, 2, 250, 255])
    ws.send(bytes)
    assert.deepEqual(new Uint8Array(await nextMessage(ws)), bytes)

    const closed = new Promise((resolve) => (ws.onclose = (event) => resolve(event)))
    ws.close(1000, "done")
    const event = await closed
    assert.equal(event.code, 1000)
  } finally {
    await echo.close()
  }
})

test("server-initiated close reaches the client with its code", async () => {
  const echo = await startEchoServer()
  try {
    const ws = await connect(`ws://127.0.0.1:${echo.port}/`)
    const closed = new Promise((resolve) => (ws.onclose = (event) => resolve(event)))
    await new Promise((resolve) => setTimeout(resolve, 20))
    echo.connections[0].close(4001, "going away")
    const event = await closed
    assert.equal(event.code, 4001)
    assert.equal(event.reason, "going away")
    assert.equal(echo.connections[0].readyState, "closed")
  } finally {
    await echo.close()
  }
})

test("non-websocket upgrade requests are rejected", async () => {
  const echo = await startEchoServer()
  try {
    const { connect: netConnect } = await import("node:net")
    const socket = netConnect(echo.port, "127.0.0.1")
    await once(socket, "connect")
    socket.write("GET / HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: h2c\r\n\r\n")
    const [data] = await once(socket, "data")
    assert.match(data.toString(), /^HTTP\/1\.1 400/)
    socket.destroy()
  } finally {
    await echo.close()
  }
})

// --- raw-socket clients for frames Node's WebSocket will not send -----------

function maskedFrame(opcode, payload, { fin = true } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  const mask = Buffer.from([1, 2, 3, 4])
  let header
  if (data.length < 126) header = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | data.length])
  else if (data.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = (fin ? 0x80 : 0) | opcode
    header[1] = 0x80 | 126
    header.writeUInt16BE(data.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = (fin ? 0x80 : 0) | opcode
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(data.length), 2)
  }
  const masked = Buffer.from(data)
  for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index % 4]
  return Buffer.concat([header, mask, masked])
}

async function rawHandshake(port) {
  const { connect: netConnect } = await import("node:net")
  const socket = netConnect(port, "127.0.0.1")
  await once(socket, "connect")
  socket.write(
    "GET / HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
  )
  const [response] = await once(socket, "data")
  assert.match(response.toString(), /^HTTP\/1\.1 101/)
  return socket
}

/** Waits for the server's close frame and returns its status code. */
function serverCloseCode(socket) {
  return new Promise((resolve) => {
    let buffer = Buffer.alloc(0)
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 0x0f
        const length = buffer[1] & 0x7f
        if (buffer.length < 2 + length) return
        const payload = buffer.subarray(2, 2 + length)
        buffer = buffer.subarray(2 + length)
        if (opcode === 0x8) return resolve(payload.readUInt16BE(0))
      }
    })
    socket.on("close", () => resolve(null))
  })
}

async function expectClose(port, write, expectedCode) {
  const socket = await rawHandshake(port)
  const code = serverCloseCode(socket)
  await write(socket)
  assert.equal(await code, expectedCode)
  socket.destroy()
}

test("protocol violations close with 1002 and oversize input with 1009", async () => {
  const echo = await startEchoServer()
  try {
    // Unmasked client frame.
    await expectClose(echo.port, (socket) => socket.write(Buffer.from([0x81, 0x02, 0x68, 0x69])), 1002)
    // Control frame with a 126-byte payload.
    await expectClose(echo.port, (socket) => socket.write(maskedFrame(0x9, Buffer.alloc(126))), 1002)
    // Fragmented control frame (FIN = 0).
    await expectClose(echo.port, (socket) => socket.write(maskedFrame(0x9, "x", { fin: false })), 1002)
    // One frame over 4 MiB (only the header is needed to trigger the check).
    await expectClose(
      echo.port,
      (socket) => {
        const header = Buffer.alloc(14)
        header[0] = 0x81
        header[1] = 0x80 | 127
        header.writeBigUInt64BE(BigInt(5 * 1024 * 1024), 2)
        socket.write(header)
      },
      1009,
    )
    // Too many fragments for one message.
    await expectClose(
      echo.port,
      (socket) => {
        socket.write(maskedFrame(0x1, "a", { fin: false }))
        for (let index = 0; index < 1100; index += 1) socket.write(maskedFrame(0x0, "a", { fin: false }))
      },
      1009,
    )
    // Fragments that together exceed 4 MiB.
    await expectClose(
      echo.port,
      (socket) => {
        const chunk = Buffer.alloc(1024 * 1024)
        socket.write(maskedFrame(0x1, chunk, { fin: false }))
        for (let index = 0; index < 4; index += 1) socket.write(maskedFrame(0x0, chunk, { fin: false }))
      },
      1009,
    )
  } finally {
    await echo.close()
  }
})

test("server pings are answered and silent peers are closed as idle", async () => {
  const echo = await startEchoServer()
  try {
    const ws = await connect(`ws://127.0.0.1:${echo.port}/`)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const server = echo.connections[0]
    const pong = once(server, "pong")
    assert.equal(server.ping(Buffer.from("hb")), true)
    const [payload] = await pong
    assert.equal(payload.toString(), "hb")
    ws.close()
  } finally {
    await echo.close()
  }

  // A raw peer that never answers pings is closed with 1001 after idleMs.
  const server = createServer()
  server.on("upgrade", (req, socket, head) => acceptWebSocket(req, socket, head, { idleMs: 150, pingIntervalMs: 50 }))
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const socket = await rawHandshake(server.address().port)
    const startedAt = Date.now()
    assert.equal(await serverCloseCode(socket), 1001)
    assert.ok(Date.now() - startedAt < 2000)
    socket.destroy()
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
