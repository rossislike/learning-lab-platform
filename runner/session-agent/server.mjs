// The session agent: one HTTP(+WebSocket) server per learner session pod.
//
//   GET  /healthz                 liveness
//   GET  /ready                   readiness + endpoint summary (dispatcher/gateway poll this)
//   GET  /state                   full agent state (debugging only; the frontend reads Convex)
//   GET  /steps/setup             scenario setup status (runs in the background at start)
//   POST /steps/:i/open           run step i's setup script (once; re-runnable after a failure)
//   POST /steps/:i/verify         run step i's verify script, report the result to Convex
//   WS   /pty?id=<n>&cols=&rows=  terminal n (created on first use; reattach replays scrollback)
//   ANY  /editor/*                OpenVSCode (served with --server-base-path /editor)
//   GET  /, /terminal.html        a minimal xterm.js page; served only when devPage is true
//
// Authentication is the gateway's job (ADR 0004); the agent port must only be
// reachable from the gateway (NetworkPolicy, Phase 3).
//
// Readiness (`/ready`): `phase` is "starting" (503) until the workspace is
// prepared and, when the scenario has an editor tab, OpenVSCode answers; then
// "ready" (200). Setup is not gated: it runs in the background and its status
// is in `setup`; the preview starts once setup has passed and its status is
// in `preview`. `phase` becomes "failed" (500, with `failure`) when setup
// exits non-zero or the editor/preview process gives up.

import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { ManagedProcess } from "./processes.mjs"
import { proxyHttp, proxyUpgrade } from "./proxy.mjs"
import { TerminalManager } from "./pty.mjs"
import { baseEnvironment, prepareWorkspace, runScript, scriptEnvironment } from "./scenario.mjs"
import { acceptWebSocket, isWebSocketUpgrade, rejectUpgrade } from "./websocket.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const MAX_REPORTED_OUTPUT = 16_000
const MAX_OUTBOUND_QUEUE_BYTES = 1024 * 1024
const OUTPUT_DROPPED_MARKER = Buffer.from("\r\n[output dropped]\r\n")
const TERMINAL_ID = /^[a-z0-9-]{1,16}$/

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
  res.end(JSON.stringify(body))
}

function parseUrl(req) {
  try {
    return new URL(req.url, "http://agent")
  } catch {
    return null
  }
}

function learnerOutput(result) {
  // Verify scripts print guidance on stdout; stderr is for authors/debugging.
  const text = result.stdout.trim() || result.stderr.trim()
  return text.slice(-MAX_REPORTED_OUTPUT)
}

/**
 * Delivers terminal output to one WebSocket with backpressure: while the
 * socket is full, chunks queue up to 1 MiB; beyond that the oldest are
 * dropped and a single marker tells the learner. Resumes on 'drain'.
 */
function createOutboundQueue(ws) {
  const queue = []
  let queued = 0
  let blocked = false
  let markerPending = false
  const flush = () => {
    blocked = false
    while (queue.length > 0 && !blocked) {
      const chunk = queue.shift()
      queued -= chunk.length
      if (ws.send(chunk) === false) blocked = true
    }
    if (queue.length === 0) markerPending = false
  }
  ws.socket.on("drain", flush)
  return (chunk) => {
    if (ws.closed) return
    if (!blocked) {
      if (ws.send(chunk) === false) blocked = true
      return
    }
    queue.push(chunk)
    queued += chunk.length
    while (queued > MAX_OUTBOUND_QUEUE_BYTES && queue.length > (markerPending ? 1 : 0)) {
      // Drop the oldest learner output, keeping the marker at the front.
      const [oldest] = queue.splice(markerPending ? 1 : 0, 1)
      queued -= oldest.length
      if (!markerPending) {
        markerPending = true
        queue.unshift(OUTPUT_DROPPED_MARKER)
        queued += OUTPUT_DROPPED_MARKER.length
      }
    }
  }
}

export function createAgent({
  scenario,
  backend,
  reporter,
  logger = console,
  editorPort = 3000,
  openvscodeBin = process.env.OPENVSCODE_SERVER_BIN ?? "openvscode-server",
  scriptTimeoutMs,
  devPage = true,
}) {
  const state = {
    startedAt: Date.now(),
    workspaceReady: false,
    scenario: {
      slug: scenario.slug,
      kind: scenario.kind,
      tabs: scenario.tabs,
      cwd: scenario.cwd,
      stepCount: scenario.steps.length,
    },
    setup: { status: scenario.manifest.setup ? "pending" : "none", output: "", durationMs: null },
    steps: scenario.steps.map((step, index) => ({
      index: index + 1,
      title: step.title,
      hasSetup: Boolean(step.setup),
      hasVerify: Boolean(step.verify),
      status: "idle",
      attempts: 0,
      output: "",
      setupRan: false,
      setupStatus: step.setup ? "pending" : "none",
      setupOutput: "",
    })),
    editor: { enabled: scenario.tabs.includes("editor"), status: "disabled", internalPort: editorPort },
    preview: {
      enabled: scenario.tabs.includes("preview"),
      status: "disabled",
      port: scenario.react?.previewPort ?? null,
    },
  }
  const processes = []
  const inFlight = new Set()
  const terminals = new TerminalManager({
    backend,
    cwd: scenario.cwd,
    env: scriptEnvironment(scenario),
  })

  function stepRecord(index) {
    const number = Number(index)
    if (!Number.isInteger(number) || number < 1 || number > state.steps.length) return null
    return state.steps[number - 1]
  }

  async function runSetup() {
    if (!scenario.manifest.setup) return
    state.setup.status = "running"
    const result = await runScript(scenario, scenario.manifest.setup, { timeoutMs: scriptTimeoutMs })
    state.setup.status = result.code === 0 ? "passed" : "failed"
    state.setup.output = (result.stdout + result.stderr).slice(-MAX_REPORTED_OUTPUT)
    state.setup.durationMs = result.durationMs
    if (result.code !== 0) {
      logger.error?.(`[setup] failed (code ${result.code}${result.timedOut ? ", timed out" : ""})\n${state.setup.output}`)
    } else {
      logger.info?.(`[setup] passed in ${result.durationMs} ms`)
    }
  }

  function startEditor() {
    if (!state.editor.enabled) return
    const userData = resolve(baseEnvironment().HOME, ".openvscode")
    const editor = new ManagedProcess({
      name: "editor",
      command: openvscodeBin,
      args: [
        "--host", "127.0.0.1",
        "--port", String(editorPort),
        "--without-connection-token",
        "--server-base-path", "/editor",
        "--server-data-dir", resolve(userData, "server"),
        "--user-data-dir", resolve(userData, "user"),
        "--extensions-dir", resolve(userData, "extensions"),
        "--default-folder", scenario.cwd,
      ],
      cwd: scenario.cwd,
      env: scriptEnvironment(scenario),
      logger,
      readyUrl: `http://127.0.0.1:${editorPort}/editor/`,
    })
    processes.push(editor)
    editor.start()
    state.editor.process = editor
  }

  function startPreview() {
    if (!state.preview.enabled || !scenario.react) return
    const preview = new ManagedProcess({
      name: "preview",
      command: "bash",
      args: ["-lc", scenario.react.devCommand],
      cwd: scenario.cwd,
      env: scriptEnvironment(scenario),
      logger,
      readyUrl: `http://127.0.0.1:${scenario.react.previewPort}/`,
    })
    processes.push(preview)
    preview.start()
    state.preview.process = preview
  }

  function summary() {
    const editorStatus = state.editor.enabled ? (state.editor.process?.status ?? "pending") : "disabled"
    const previewStatus = state.preview.enabled ? (state.preview.process?.status ?? "pending") : "disabled"
    let failure = null
    if (state.setup.status === "failed") failure = { component: "setup", output: state.setup.output }
    else if (editorStatus === "failed") failure = { component: "editor", output: state.editor.process?.lastOutput ?? "" }
    else if (previewStatus === "failed") failure = { component: "preview", output: state.preview.process?.lastOutput ?? "" }
    const ready = state.workspaceReady && (!state.editor.enabled || editorStatus === "running")
    const phase = failure ? "failed" : ready ? "ready" : "starting"
    return {
      ready: phase === "ready",
      phase,
      failure,
      scenario: state.scenario,
      setup: { status: state.setup.status, durationMs: state.setup.durationMs },
      editor: { enabled: state.editor.enabled, status: editorStatus, internalPort: state.editor.internalPort, path: "/editor/" },
      preview: { enabled: state.preview.enabled, status: previewStatus, port: state.preview.port },
      terminals: terminals.list(),
      uptimeMs: Date.now() - state.startedAt,
    }
  }

  async function openStep(record) {
    const step = scenario.steps[record.index - 1]
    if (!step.setup || record.setupRan) return { ran: false, ok: record.setupStatus !== "failed", output: record.setupOutput }
    const key = `open:${record.index}`
    if (inFlight.has(key)) return { busy: true }
    inFlight.add(key)
    record.setupStatus = "running"
    try {
      const result = await runScript(scenario, step.setup, { stepIndex: record.index, timeoutMs: scriptTimeoutMs })
      const ok = result.code === 0 && !result.timedOut
      // Only a successful run counts as done, so a retry after a failure re-runs it.
      record.setupRan = ok
      record.setupStatus = ok ? "passed" : "failed"
      record.setupOutput = learnerOutput(result)
      return { ran: true, ok, output: record.setupOutput, timedOut: result.timedOut }
    } finally {
      inFlight.delete(key)
    }
  }

  async function verifyStep(record) {
    const step = scenario.steps[record.index - 1]
    if (!step.verify) return { passed: true, noVerify: true, output: "", reported: false }
    const key = `verify:${record.index}`
    if (inFlight.has(key)) return { busy: true }
    inFlight.add(key)
    record.status = "running"
    try {
      const result = await runScript(scenario, step.verify, { stepIndex: record.index, timeoutMs: scriptTimeoutMs })
      const passed = result.code === 0 && !result.timedOut
      record.status = passed ? "passed" : "failed"
      record.attempts += 1
      record.lastRunAt = Date.now()
      record.durationMs = result.durationMs
      record.output = result.timedOut
        ? `The check timed out after ${Math.round(result.durationMs / 1000)} s.`
        : passed
          ? ""
          : learnerOutput(result) || "The check did not pass yet."
      const reported = await reporter.recordStepResult({
        stepIndex: record.index,
        passed,
        output: record.output,
      })
      return { passed, output: record.output, durationMs: result.durationMs, timedOut: result.timedOut, reported: reported.reported }
    } finally {
      inFlight.delete(key)
    }
  }

  async function handleRequest(req, res) {
    const url = parseUrl(req)
    if (!url) return json(res, 400, { error: "malformed request target" })
    const { pathname } = url
    try {
      if (pathname === "/healthz") return json(res, 200, { ok: true })
      if (pathname === "/ready") {
        const body = summary()
        return json(res, body.phase === "ready" ? 200 : body.phase === "failed" ? 500 : 503, body)
      }
      if (pathname === "/state") {
        return json(res, 200, { ...summary(), setupOutput: state.setup.output, steps: state.steps })
      }
      if (pathname === "/steps/setup") return json(res, 200, state.setup)
      const stepMatch = pathname.match(/^\/steps\/(\d+)\/(open|verify)$/)
      if (stepMatch) {
        if (req.method !== "POST") return json(res, 405, { error: "POST required" })
        const record = stepRecord(stepMatch[1])
        if (!record) return json(res, 404, { error: "no such step" })
        const result = stepMatch[2] === "open" ? await openStep(record) : await verifyStep(record)
        if (result.busy) return json(res, 409, { error: `${stepMatch[2]} already running` })
        return json(res, 200, result)
      }
      if (pathname === "/editor" || pathname.startsWith("/editor/")) {
        if (!state.editor.enabled) return json(res, 404, { error: "editor is not enabled for this scenario" })
        return proxyHttp(req, res, { port: editorPort })
      }
      if (devPage && (pathname === "/" || pathname === "/terminal.html")) {
        const page = await readFile(resolve(__dirname, "public/terminal.html"))
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
        return res.end(page)
      }
      return json(res, 404, { error: "not found" })
    } catch (error) {
      logger.error?.(`[agent] ${req.method} ${pathname} failed: ${error.stack ?? error}`)
      if (!res.headersSent) json(res, 500, { error: "internal error" })
      else res.destroy()
    }
  }

  function handleUpgrade(req, socket, head) {
    socket.on("error", () => {})
    const url = parseUrl(req)
    if (!url) return rejectUpgrade(socket, 400, "Bad Request")
    if (url.pathname === "/editor" || url.pathname.startsWith("/editor/")) {
      if (!state.editor.enabled) return rejectUpgrade(socket, 404, "Not Found")
      return proxyUpgrade(req, socket, head, { port: editorPort })
    }
    if (url.pathname !== "/pty") return rejectUpgrade(socket, 404, "Not Found")
    if (!isWebSocketUpgrade(req)) return rejectUpgrade(socket, 400, "WebSocket Required")
    const id = url.searchParams.get("id") ?? "1"
    if (!TERMINAL_ID.test(id)) return rejectUpgrade(socket, 400, "Invalid Terminal Id")
    const cols = Number(url.searchParams.get("cols")) || undefined
    const rows = Number(url.searchParams.get("rows")) || undefined
    let terminal
    try {
      terminal = terminals.getOrCreate(id, { cols, rows })
    } catch (error) {
      return rejectUpgrade(socket, 429, error.message)
    }
    const ws = acceptWebSocket(req, socket, head)
    if (!ws) return
    const deliver = createOutboundQueue(ws)
    if (terminal.scrollback.length > 0) deliver(terminal.scrollback)
    const detach = terminal.onData(deliver)
    ws.on("message", (data, isBinary) => {
      if (isBinary) return terminal.write(data)
      if (data.startsWith("\u0000")) {
        // Control channel: "\0" + JSON, so plain keystrokes are never misread.
        try {
          const control = JSON.parse(data.slice(1))
          if (control.type === "resize") terminal.resize(Number(control.cols), Number(control.rows))
        } catch {
          /* ignore malformed control messages */
        }
        return
      }
      terminal.write(data)
    })
    ws.on("close", detach)
    ws.on("error", () => {})
  }

  const server = createServer(handleRequest)
  // Slow-header protection; requests themselves may run as long as a verify
  // script (scriptTimeoutMs, default 10 min) so requestTimeout stays generous.
  server.headersTimeout = 30_000
  server.requestTimeout = Math.max(300_000, (scriptTimeoutMs ?? 0) + 30_000)
  server.on("upgrade", handleUpgrade)
  server.on("clientError", (error, socket) => {
    if (error.code === "ECONNRESET" || !socket.writable) return socket.destroy()
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
  })

  let setupPromise = null

  /**
   * Resolves once the agent is usable (workspace prepared, editor launched).
   * Setup keeps running in the background; await `agent.settled()` for it.
   */
  async function start() {
    await prepareWorkspace(scenario, { logger })
    state.workspaceReady = true
    startEditor()
    setupPromise = runSetup()
      .then(() => {
        if (state.setup.status !== "failed") startPreview()
      })
      .catch((error) => {
        state.setup.status = "failed"
        state.setup.output = String(error?.stack ?? error)
        logger.error?.(`[setup] crashed: ${state.setup.output}`)
      })
  }

  /** Resolves when the background setup has finished (passed or failed). */
  function settled() {
    return setupPromise ?? Promise.resolve()
  }

  function shutdown() {
    terminals.killAll()
    for (const process of processes) process.stop()
    server.close()
  }

  return { server, state, start, settled, shutdown, summary }
}
