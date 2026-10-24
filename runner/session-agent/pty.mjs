// Terminal sessions for the agent.
//
// Uses node-pty when it is installed (the session-workspace image installs
// it). Falls back to a plain pipe-backed bash when it is not, which is enough
// for unit tests and for running the agent on a developer machine without
// native modules — but without a real TTY (no prompt colours, no resize).

import { spawn } from "node:child_process"

const DEFAULT_COLS = 120
const DEFAULT_ROWS = 32
const SCROLLBACK_BYTES = 64 * 1024

export async function loadPtyBackend({ logger = console } = {}) {
  try {
    const nodePty = await import("node-pty")
    return { name: "node-pty", spawn: (options) => new NodePtyTerminal(nodePty, options) }
  } catch {
    logger.warn?.("[pty] node-pty is not installed; falling back to pipe-backed shells (no TTY)")
    return { name: "pipe", spawn: (options) => new PipeTerminal(options) }
  }
}

/** Keeps a scrollback buffer so a reconnecting client can catch up. */
class BaseTerminal {
  constructor() {
    this.listeners = new Set()
    this.scrollback = Buffer.alloc(0)
    this.exited = false
    this.exitCode = null
  }
  onData(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  _emit(data) {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data)
    this.scrollback = Buffer.concat([this.scrollback, chunk])
    if (this.scrollback.length > SCROLLBACK_BYTES) {
      this.scrollback = this.scrollback.subarray(this.scrollback.length - SCROLLBACK_BYTES)
    }
    for (const listener of this.listeners) listener(chunk)
  }
  _exit(code) {
    this.exited = true
    this.exitCode = code
    this._emit(`\r\n[process exited with code ${code}]\r\n`)
  }
}

class NodePtyTerminal extends BaseTerminal {
  constructor(nodePty, { shell, args, cwd, env, cols, rows }) {
    super()
    this.term = nodePty.spawn(shell, args, {
      name: "xterm-256color",
      cols: cols ?? DEFAULT_COLS,
      rows: rows ?? DEFAULT_ROWS,
      cwd,
      env,
    })
    this.term.onData((data) => this._emit(data))
    this.term.onExit(({ exitCode }) => this._exit(exitCode))
  }
  write(data) {
    if (!this.exited) this.term.write(typeof data === "string" ? data : data.toString("utf8"))
  }
  resize(cols, rows) {
    if (!this.exited && cols > 0 && rows > 0) this.term.resize(cols, rows)
  }
  kill() {
    if (!this.exited) this.term.kill()
  }
}

class PipeTerminal extends BaseTerminal {
  constructor({ shell, args, cwd, env }) {
    super()
    this.child = spawn(shell, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] })
    this.child.stdout.on("data", (data) => this._emit(data))
    this.child.stderr.on("data", (data) => this._emit(data))
    this.child.on("exit", (code) => this._exit(code ?? 1))
    this.child.on("error", (error) => this._emit(`[shell error: ${error.message}]\r\n`))
  }
  write(data) {
    if (!this.exited && this.child.stdin.writable) this.child.stdin.write(data)
  }
  resize() {}
  kill() {
    if (!this.exited) this.child.kill("SIGHUP")
  }
}

/** Named terminals for one session; ids come from the client ("1", "2", …). */
export class TerminalManager {
  constructor({ backend, shell = "/bin/bash", args = ["-l"], cwd, env, maxTerminals = 8 }) {
    this.backend = backend
    this.shell = shell
    this.args = args
    this.cwd = cwd
    this.env = env
    this.maxTerminals = maxTerminals
    this.terminals = new Map()
  }

  getOrCreate(id, { cols, rows } = {}) {
    const existing = this.terminals.get(id)
    if (existing && !existing.exited) return existing
    if (this.terminals.size >= this.maxTerminals && !existing) {
      throw new Error(`terminal limit reached (${this.maxTerminals})`)
    }
    const terminal = this.backend.spawn({
      shell: this.shell,
      args: this.args,
      cwd: this.cwd,
      env: this.env,
      cols,
      rows,
    })
    this.terminals.set(id, terminal)
    return terminal
  }

  list() {
    return [...this.terminals.entries()].map(([id, terminal]) => ({
      id,
      exited: terminal.exited,
      exitCode: terminal.exitCode,
    }))
  }

  killAll() {
    for (const terminal of this.terminals.values()) terminal.kill()
    this.terminals.clear()
  }
}
