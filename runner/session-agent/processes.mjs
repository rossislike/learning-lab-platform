// Long-running child processes the agent supervises (OpenVSCode, the Vite dev
// server). Each is restarted a bounded number of times and killed on shutdown.

import { spawn } from "node:child_process"
import { request } from "node:http"

const MAX_RESTARTS = 3
const RESTART_DELAY_MS = 2000

export class ManagedProcess {
  constructor({ name, command, args, cwd, env, logger = console, readyUrl, readyTimeoutMs = 120_000 }) {
    this.name = name
    this.command = command
    this.args = args
    this.cwd = cwd
    this.env = env
    this.logger = logger
    this.readyUrl = readyUrl
    this.readyTimeoutMs = readyTimeoutMs
    this.child = null
    this.restarts = 0
    this.stopped = false
    this.status = "pending"
    this.lastOutput = ""
  }

  start() {
    if (this.stopped) return
    this.status = "starting"
    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const capture = (chunk) => {
      this.lastOutput = `${this.lastOutput}${chunk}`.slice(-8192)
    }
    this.child.stdout.on("data", capture)
    this.child.stderr.on("data", capture)
    this.child.on("error", (error) => {
      this.logger.error?.(`[${this.name}] failed to start: ${error.message}`)
      this.status = "failed"
    })
    this.child.on("exit", (code, signal) => {
      this.logger.warn?.(`[${this.name}] exited (code ${code}, signal ${signal})`)
      this.child = null
      if (this.stopped) return
      if (this.restarts >= MAX_RESTARTS) {
        this.status = "failed"
        return
      }
      this.restarts += 1
      this.status = "restarting"
      setTimeout(() => this.start(), RESTART_DELAY_MS).unref()
    })
    this.logger.info?.(`[${this.name}] started pid ${this.child.pid}`)
    void this.#watchReady()
  }

  async #watchReady() {
    if (!this.readyUrl) {
      this.status = "running"
      return
    }
    const deadline = Date.now() + this.readyTimeoutMs
    while (!this.stopped && this.child && Date.now() < deadline) {
      if (await httpReachable(this.readyUrl)) {
        this.status = "running"
        this.logger.info?.(`[${this.name}] ready at ${this.readyUrl}`)
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    if (this.status === "starting") this.status = "failed"
  }

  stop(signal = "SIGTERM") {
    this.stopped = true
    this.status = "stopped"
    if (this.child) this.child.kill(signal)
  }
}

export function httpReachable(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = request(url, { method: "GET", timeout: timeoutMs }, (res) => {
      res.resume()
      resolve((res.statusCode ?? 500) < 500)
    })
    req.on("timeout", () => req.destroy())
    req.on("error", () => resolve(false))
    req.end()
  })
}
