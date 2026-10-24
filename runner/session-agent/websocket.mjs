// Minimal RFC 6455 WebSocket server side, enough for terminal traffic.
// No dependencies, so the agent stays testable with Node's built-in client.
//
//   server.on("upgrade", (req, socket, head) => {
//     const ws = acceptWebSocket(req, socket, head)
//     ws.on("message", (data, isBinary) => ...)
//     ws.send("text") / ws.send(buffer) / ws.close(1000, "bye")
//   })
//
// Limits: one frame or one assembled fragmented message is at most 4 MiB
// (1009), at most 1024 fragments per message (1009), control frames must be
// unfragmented and ≤ 125 bytes (1002), clients must mask (1002). The server
// pings every `pingIntervalMs` and closes with 1001 when nothing has been
// received for `idleMs` (TCP keep-alive is also enabled).

import { createHash } from "node:crypto"
import { EventEmitter } from "node:events"

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
export const MAX_FRAME_BYTES = 4 * 1024 * 1024
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024
export const MAX_FRAGMENTS = 1024
const MAX_CONTROL_PAYLOAD = 125
const DEFAULT_IDLE_MS = 60_000
const DEFAULT_PING_INTERVAL_MS = 25_000

export function isWebSocketUpgrade(req) {
  return (
    req.headers.upgrade?.toLowerCase() === "websocket" &&
    typeof req.headers["sec-websocket-key"] === "string"
  )
}

export function rejectUpgrade(socket, status = 400, message = "Bad Request") {
  if (socket.destroyed) return
  socket.write(
    `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  )
  socket.destroy()
}

export function acceptWebSocket(req, socket, head, options = {}) {
  const key = req.headers["sec-websocket-key"]
  const version = req.headers["sec-websocket-version"]
  if (!isWebSocketUpgrade(req) || version !== "13") {
    rejectUpgrade(socket, 400, "Bad WebSocket Request")
    return null
  }
  const accept = createHash("sha1").update(`${key}${GUID}`).digest("base64")
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "\r\n",
    ].join("\r\n"),
  )
  return new WebSocketConnection(socket, head, options)
}

export class WebSocketConnection extends EventEmitter {
  constructor(socket, head, { idleMs = DEFAULT_IDLE_MS, pingIntervalMs = DEFAULT_PING_INTERVAL_MS } = {}) {
    super()
    this.socket = socket
    this.closed = false
    this.buffer = Buffer.alloc(0)
    this.fragments = null
    this.lastSeenAt = Date.now()
    this.awaitingPong = false
    socket.setNoDelay?.(true)
    socket.setKeepAlive?.(true, Math.min(idleMs, 30_000))
    socket.on("data", (chunk) => this.#onData(chunk))
    socket.on("close", () => this.#finish(1006, "connection lost"))
    socket.on("error", (error) => {
      this.emit("error", error)
      this.#finish(1006, error.message)
    })
    // Socket inactivity (neither direction) is an extra backstop; the ping
    // timer below is what catches a half-open peer behind a chatty terminal.
    if (idleMs > 0) {
      socket.setTimeout(idleMs, () => {
        if (this.awaitingPong || Date.now() - this.lastSeenAt >= idleMs) this.close(1001, "idle")
      })
    }
    if (pingIntervalMs > 0) {
      this.pingTimer = setInterval(() => {
        if (this.closed) return
        if (Date.now() - this.lastSeenAt >= idleMs) return this.close(1001, "idle")
        this.awaitingPong = true
        this.ping()
      }, pingIntervalMs)
      this.pingTimer.unref?.()
    }
    if (head && head.length > 0) this.#onData(head)
  }

  get readyState() {
    return this.closed ? "closed" : "open"
  }

  /** `false` when the socket buffer is full; wait for `socket.on("drain")`. */
  send(data) {
    if (this.closed) return false
    const isBinary = Buffer.isBuffer(data) || data instanceof Uint8Array
    const payload = isBinary ? Buffer.from(data) : Buffer.from(String(data), "utf8")
    return this.#writeFrame(isBinary ? 0x2 : 0x1, payload)
  }

  ping(payload = Buffer.alloc(0)) {
    if (this.closed) return false
    return this.#writeFrame(0x9, Buffer.from(payload).subarray(0, MAX_CONTROL_PAYLOAD))
  }

  close(code = 1000, reason = "") {
    if (this.closed) return
    const reasonBytes = Buffer.from(reason, "utf8").subarray(0, 123)
    const payload = Buffer.alloc(2 + reasonBytes.length)
    payload.writeUInt16BE(code, 0)
    reasonBytes.copy(payload, 2)
    this.#writeFrame(0x8, payload)
    this.#finish(code, reason)
  }

  #writeFrame(opcode, payload) {
    if (this.socket.destroyed) return false
    let header
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, payload.length])
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4)
      header[0] = 0x80 | opcode
      header[1] = 126
      header.writeUInt16BE(payload.length, 2)
    } else {
      header = Buffer.alloc(10)
      header[0] = 0x80 | opcode
      header[1] = 127
      header.writeBigUInt64BE(BigInt(payload.length), 2)
    }
    return this.socket.write(Buffer.concat([header, payload]))
  }

  #onData(chunk) {
    if (this.closed) return
    this.lastSeenAt = Date.now()
    this.awaitingPong = false
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    while (!this.closed) {
      const frame = this.#readFrame()
      if (!frame) break
      this.#handleFrame(frame)
    }
  }

  #readFrame() {
    const buf = this.buffer
    if (buf.length < 2) return null
    const fin = (buf[0] & 0x80) !== 0
    const opcode = buf[0] & 0x0f
    const masked = (buf[1] & 0x80) !== 0
    let length = buf[1] & 0x7f
    let offset = 2
    if (opcode >= 0x8 && (length > MAX_CONTROL_PAYLOAD || !fin)) {
      // Control frames are never fragmented and carry ≤ 125 bytes (RFC 6455 §5.5).
      this.close(1002, "invalid control frame")
      return null
    }
    if (length === 126) {
      if (buf.length < 4) return null
      length = buf.readUInt16BE(2)
      offset = 4
    } else if (length === 127) {
      if (buf.length < 10) return null
      const big = buf.readBigUInt64BE(2)
      if (big > BigInt(MAX_FRAME_BYTES)) {
        this.close(1009, "frame too large")
        return null
      }
      length = Number(big)
      offset = 10
    }
    if (length > MAX_FRAME_BYTES) {
      this.close(1009, "frame too large")
      return null
    }
    if (!masked) {
      // Clients must mask every frame (RFC 6455 §5.1).
      this.close(1002, "unmasked frame")
      return null
    }
    if (buf.length < offset + 4 + length) return null
    const mask = buf.subarray(offset, offset + 4)
    const payload = Buffer.from(buf.subarray(offset + 4, offset + 4 + length))
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index % 4]
    }
    this.buffer = buf.subarray(offset + 4 + length)
    return { fin, opcode, payload }
  }

  #handleFrame({ fin, opcode, payload }) {
    switch (opcode) {
      case 0x0: // continuation
        if (!this.fragments) return this.close(1002, "unexpected continuation")
        this.fragments.parts.push(payload)
        this.fragments.bytes += payload.length
        if (this.fragments.bytes > MAX_MESSAGE_BYTES || this.fragments.parts.length > MAX_FRAGMENTS) {
          return this.close(1009, "message too large")
        }
        if (fin) {
          const { opcode: firstOpcode, parts } = this.fragments
          this.fragments = null
          this.#deliver(firstOpcode, Buffer.concat(parts))
        }
        return
      case 0x1:
      case 0x2:
        if (this.fragments) return this.close(1002, "interleaved fragments")
        if (fin) return this.#deliver(opcode, payload)
        this.fragments = { opcode, parts: [payload], bytes: payload.length }
        return
      case 0x8: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005
        const reason = payload.length > 2 ? payload.subarray(2).toString("utf8") : ""
        if (!this.closed) this.#writeFrame(0x8, payload.subarray(0, 2))
        this.#finish(code, reason)
        return
      }
      case 0x9:
        this.#writeFrame(0xa, payload)
        return
      case 0xa:
        this.emit("pong", payload)
        return
      default:
        this.close(1002, `unsupported opcode ${opcode}`)
    }
  }

  #deliver(opcode, payload) {
    const isBinary = opcode === 0x2
    this.emit("message", isBinary ? payload : payload.toString("utf8"), isBinary)
  }

  #finish(code, reason) {
    if (this.closed) return
    this.closed = true
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.socket.setTimeout?.(0)
    this.socket.end()
    setTimeout(() => this.socket.destroy(), 1000).unref()
    this.emit("close", code, reason)
  }
}
