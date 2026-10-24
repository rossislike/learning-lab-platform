// Exercises the agent end to end against the real git/first-commit scenario
// with the pipe-backed terminal (no node-pty needed).

import assert from "node:assert/strict"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import test from "node:test"
import { loadPtyBackend } from "./pty.mjs"
import { createReporter } from "./reporter.mjs"
import { loadScenario, runScript, scriptEnvironment } from "./scenario.mjs"
import { createAgent } from "./server.mjs"

const repoRoot = new URL("../../", import.meta.url).pathname
const quiet = { info() {}, warn() {}, error() {} }
// Staged scenarios live under os.tmpdir(), which is not /tmp on macOS.
process.env.AGENT_ALLOWED_WORKSPACE_ROOTS = `/workspace,/home,/tmp,${tmpdir()}`

async function stageScenario(slug = "git/first-commit") {
  const root = await mkdtemp(resolve(tmpdir(), "llp-agent-"))
  const scenarioDir = resolve(root, "scenario")
  await cp(resolve(repoRoot, "scenarios", slug), scenarioDir, { recursive: true })
  const manifestPath = resolve(scenarioDir, "manifest.json")
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  manifest.workspace.cwd = resolve(root, "workspace")
  await writeFile(manifestPath, JSON.stringify(manifest))
  return { root, scenarioDir, cleanup: () => rm(root, { recursive: true, force: true }) }
}

async function startAgent(scenarioDir, overrides = {}) {
  const scenario = await loadScenario(scenarioDir)
  const backend = await loadPtyBackend({ logger: quiet })
  const calls = []
  const reporter = {
    enabled: true,
    recordStepResult: async (args) => {
      calls.push(args)
      return { reported: true }
    },
  }
  const agent = createAgent({ scenario, backend, reporter, logger: quiet, ...overrides })
  await new Promise((resolve) => agent.server.listen(0, "127.0.0.1", resolve))
  const { port } = agent.server.address()
  await agent.start()
  if (overrides.awaitSetup !== false) await agent.settled()
  return { agent, port, calls, base: `http://127.0.0.1:${port}` }
}

function openTerminal(base, id = "1") {
  const ws = new WebSocket(`${base.replace("http", "ws")}/pty?id=${id}&cols=80&rows=24`)
  ws.binaryType = "arraybuffer"
  let output = ""
  ws.onmessage = (event) => {
    output += typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8")
  }
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve({ ws, read: () => output })
    ws.onerror = () => reject(new Error("terminal connect failed"))
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test("agent runs setup, serves readiness, verifies steps through the terminal, and reports results", async () => {
  const staged = await stageScenario()
  const previousHome = process.env.HOME
  process.env.HOME = resolve(staged.root, "home")
  let agent
  try {
    const started = await startAgent(staged.scenarioDir)
    agent = started.agent
    const { base, calls } = started

    const ready = await fetch(`${base}/ready`).then((r) => r.json())
    assert.equal(ready.ready, true)
    assert.equal(ready.phase, "ready")
    assert.equal(ready.failure, null)
    assert.equal(ready.scenario.slug, "first-commit")
    assert.equal(ready.scenario.stepCount, 3)
    assert.deepEqual(ready.editor, { enabled: false, status: "disabled", internalPort: 3000, path: "/editor/" })
    assert.equal((await fetch(`${base}/steps/setup`).then((r) => r.json())).status, "passed")
    assert.equal((await fetch(`${base}/healthz`)).status, 200)

    const failing = await fetch(`${base}/steps/1/verify`, { method: "POST" }).then((r) => r.json())
    assert.equal(failing.passed, false)
    assert.match(failing.output, /git init/)
    assert.deepEqual(calls.at(-1), { stepIndex: 1, passed: false, output: failing.output })

    const terminal = await openTerminal(base)
    terminal.ws.send("echo marker-$((40+2))\n")
    terminal.ws.send("cd journal && git init -q && git add day1.md && git commit -q -m 'first' && echo committed\n")
    await sleep(700)
    assert.match(terminal.read(), /marker-42/)
    assert.match(terminal.read(), /committed/)
    terminal.ws.close()

    for (const step of [1, 2, 3]) {
      const result = await fetch(`${base}/steps/${step}/verify`, { method: "POST" }).then((r) => r.json())
      assert.equal(result.passed, true, `step ${step} passes after the terminal work`)
    }
    assert.equal(calls.length, 4)
    assert.equal(calls.at(-1).stepIndex, 3)

    // Reattaching to the same terminal id replays scrollback.
    const again = await openTerminal(base)
    await sleep(100)
    assert.match(again.read(), /marker-42/)
    again.ws.close()

    const state = await fetch(`${base}/state`).then((r) => r.json())
    assert.equal(state.steps[0].attempts, 2)
    assert.equal(state.steps[0].status, "passed")
    assert.equal(state.terminals.length, 1)

    assert.equal((await fetch(`${base}/steps/9/verify`, { method: "POST" })).status, 404)
    assert.equal((await fetch(`${base}/steps/1/verify`)).status, 405)
    assert.equal((await fetch(`${base}/editor/`)).status, 404)
    assert.equal((await fetch(`${base}/nope`)).status, 404)
    const page = await fetch(`${base}/`)
    assert.match(page.headers.get("content-type"), /text\/html/)
  } finally {
    process.env.HOME = previousHome
    agent?.shutdown()
    await staged.cleanup()
  }
})

test("react scenarios get workspace/ copied before setup and expose preview metadata", async () => {
  const staged = await stageScenario("react/welcome-message")
  // Replace the real install with a no-op so the test needs no registry.
  await writeFile(resolve(staged.scenarioDir, "scripts/setup.sh"), "#!/usr/bin/env bash\necho setup-ran\n")
  const scenario = await loadScenario(staged.scenarioDir)
  const backend = await loadPtyBackend({ logger: quiet })
  const agent = createAgent({
    scenario,
    backend,
    reporter: createReporter({ logger: quiet }),
    logger: quiet,
    openvscodeBin: "/nonexistent/openvscode-server",
  })
  try {
    await agent.start()
    await agent.settled()
    const files = await readFile(resolve(scenario.cwd, "package.json"), "utf8")
    assert.match(files, /react-welcome-message|"name"/)
    const summary = agent.summary()
    assert.equal(summary.setup.status, "passed")
    assert.equal(summary.preview.enabled, true)
    assert.equal(summary.preview.port, 5173)
    assert.equal(summary.editor.enabled, true)
    assert.equal(summary.ready, false, "editor binary missing → not ready")
    assert.equal(summary.editor.internalPort, 3000)
  } finally {
    agent.shutdown()
    await staged.cleanup()
  }
})

test("runScript enforces the scripts/ path contract and the timeout", async () => {
  const staged = await stageScenario()
  try {
    const scenario = await loadScenario(staged.scenarioDir)
    await mkdir(scenario.cwd, { recursive: true })
    const escape = await runScript(scenario, "../etc/passwd")
    assert.equal(escape.code, 1)
    assert.match(escape.stderr, /invalid script path/)

    await writeFile(resolve(staged.scenarioDir, "scripts/slow.sh"), "sleep 5\n")
    const startedAt = Date.now()
    const slow = await runScript(scenario, "scripts/slow.sh", { timeoutMs: 200 })
    assert.equal(slow.timedOut, true)
    assert.notEqual(slow.code, 0)
    assert.ok(Date.now() - startedAt < 3000, "timeout kills the whole process group")

    const env = scriptEnvironment(scenario, { LAB_STEP: "2" })
    assert.equal(env.LAB_STEP, "2")
    assert.equal(env.LAB_SCENARIO_DIR, scenario.dir)
    assert.equal(env.LAB_WORKSPACE, scenario.cwd)
  } finally {
    await staged.cleanup()
  }
})

test("learner environment is an allowlist and never carries agent secrets", async () => {
  const secrets = {
    SESSION_TOKEN: "secret-token",
    CONVEX_URL: "https://example.convex.cloud",
    CONVEX_DEPLOY_KEY: "prod:deploy-key",
    AWS_SECRET_ACCESS_KEY: "nope",
    npm_config__authToken: "npm-token",
    KUBERNETES_SERVICE_HOST: "10.0.0.1",
    SOME_RANDOM_INJECTED: "x",
    LAB_EXTRA: "kept",
    LC_ALL: "C.UTF-8",
    EXPLICIT_PASS: "yes",
  }
  Object.assign(process.env, secrets)
  process.env.AGENT_LEARNER_ENV_PASSTHROUGH = "EXPLICIT_PASS"
  try {
    const staged = await stageScenario()
    const scenario = await loadScenario(staged.scenarioDir)
    const env = scriptEnvironment(scenario)
    for (const name of [
      "SESSION_TOKEN", "CONVEX_URL", "CONVEX_DEPLOY_KEY", "AWS_SECRET_ACCESS_KEY",
      "npm_config__authToken", "KUBERNETES_SERVICE_HOST", "SOME_RANDOM_INJECTED",
      "AGENT_LEARNER_ENV_PASSTHROUGH", "AGENT_ALLOWED_WORKSPACE_ROOTS",
    ]) {
      assert.equal(env[name], undefined, `${name} must not reach learner shells`)
    }
    assert.equal(env.LAB_EXTRA, "kept")
    assert.equal(env.LC_ALL, "C.UTF-8")
    assert.equal(env.EXPLICIT_PASS, "yes")
    assert.equal(env.PATH, process.env.PATH)
    assert.ok(env.TERM)
    assert.ok(env.HOME)
    assert.ok(env.LANG)
    await staged.cleanup()
  } finally {
    for (const name of Object.keys(secrets)) delete process.env[name]
    delete process.env.AGENT_LEARNER_ENV_PASSTHROUGH
  }
})

test("workspace.cwd must live under an allowed root", async () => {
  const staged = await stageScenario()
  try {
    const manifestPath = resolve(staged.scenarioDir, "manifest.json")
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
    manifest.workspace.cwd = "/etc/cron.d"
    await writeFile(manifestPath, JSON.stringify(manifest))
    await assert.rejects(loadScenario(staged.scenarioDir), /workspace\.cwd must be under/)
    manifest.workspace.cwd = "/workspace/../etc"
    await writeFile(manifestPath, JSON.stringify(manifest))
    await assert.rejects(loadScenario(staged.scenarioDir), /workspace\.cwd must be under/)
  } finally {
    await staged.cleanup()
  }
})

test("reporter posts to the Convex HTTP API with the session token and tolerates failure", async () => {
  const requests = []
  const fetchImpl = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) })
    if (requests.length === 1) return { ok: false, status: 500, json: async () => ({ errorMessage: "boom" }) }
    return { ok: true, status: 200, json: async () => ({ status: "success", value: { completedSteps: 1 } }) }
  }
  const reporter = createReporter({
    convexUrl: "https://example.convex.cloud",
    sessionId: "s1",
    sessionToken: "tok",
    logger: quiet,
    fetchImpl,
  })
  const result = await reporter.recordStepResult({ stepIndex: 1, passed: true, output: "" })
  assert.equal(result.reported, true)
  assert.equal(requests.length, 2, "retried once after a 5xx")
  assert.equal(requests[0].url, "https://example.convex.cloud/api/mutation")
  assert.deepEqual(requests[0].body.args, { sessionId: "s1", sessionToken: "tok", stepIndex: 1, passed: true, output: "" })
  assert.equal(requests[0].body.path, "steps:recordStepResult")

  const failing = createReporter({
    convexUrl: "https://example.convex.cloud",
    sessionId: "s1",
    sessionToken: "tok",
    logger: quiet,
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ errorMessage: "bad token" }) }),
  })
  const denied = await failing.recordStepResult({ stepIndex: 1, passed: true })
  assert.deepEqual(denied, { reported: false, error: "bad token" })
})

test("malformed request targets get 400 instead of crashing the agent", async () => {
  const staged = await stageScenario()
  let agent
  try {
    const started = await startAgent(staged.scenarioDir)
    agent = started.agent
    const { connect } = await import("node:net")
    const { once } = await import("node:events")
    for (const upgrade of [false, true]) {
      const socket = connect(started.port, "127.0.0.1")
      await once(socket, "connect")
      socket.write(
        `GET http://[::1 HTTP/1.1\r\nHost: x\r\n${upgrade ? "Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n" : ""}\r\n`,
      )
      const [data] = await once(socket, "data")
      assert.match(data.toString(), /^HTTP\/1\.1 400/, upgrade ? "upgrade" : "request")
      socket.destroy()
    }
    assert.equal((await fetch(`${started.base}/healthz`)).status, 200, "agent still serves")
  } finally {
    agent?.shutdown()
    await staged.cleanup()
  }
})

test("step open runs setup once under concurrency and re-runs after a failure; verify is 409 while in flight", async () => {
  const staged = await stageScenario()
  const manifestPath = resolve(staged.scenarioDir, "manifest.json")
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  manifest.steps[1].setup = "scripts/step2-setup.sh"
  manifest.steps[2].verify = "scripts/slow-verify.sh"
  await writeFile(manifestPath, JSON.stringify(manifest))
  await writeFile(
    resolve(staged.scenarioDir, "scripts/step2-setup.sh"),
    '#!/usr/bin/env bash\nsleep 0.3\necho run >> "$LAB_WORKSPACE/setup-runs"\n[ "$(wc -l < "$LAB_WORKSPACE/setup-runs")" -ge 2 ] || { echo "first run fails"; exit 1; }\necho ok\n',
  )
  await writeFile(resolve(staged.scenarioDir, "scripts/slow-verify.sh"), "#!/usr/bin/env bash\nsleep 0.5\nexit 0\n")
  let agent
  try {
    const started = await startAgent(staged.scenarioDir)
    agent = started.agent
    const { base } = started
    const open = () => fetch(`${base}/steps/2/open`, { method: "POST" })
    const [first, second] = await Promise.all([open(), open()])
    const statuses = [first.status, second.status].sort()
    assert.deepEqual(statuses, [200, 409], "the concurrent open is rejected, not run twice")
    const ran = await (first.status === 200 ? first : second).json()
    assert.deepEqual({ ran: ran.ran, ok: ran.ok }, { ran: true, ok: false })
    assert.match(ran.output, /first run fails/)
    assert.equal((await readFile(resolve(staged.root, "workspace/setup-runs"), "utf8")).trim(), "run")

    const retry = await open().then((r) => r.json())
    assert.deepEqual({ ran: retry.ran, ok: retry.ok }, { ran: true, ok: true }, "a failed setup can be re-run")
    const again = await open().then((r) => r.json())
    assert.deepEqual({ ran: again.ran, ok: again.ok }, { ran: false, ok: true }, "a passed setup is not re-run")
    const state = await fetch(`${base}/state`).then((r) => r.json())
    assert.equal(state.steps[1].setupStatus, "passed")
    assert.equal(state.steps[1].setupRan, true)
    assert.equal((await fetch(`${base}/steps/1/open`, { method: "POST" }).then((r) => r.json())).ran, false)

    const verify = () => fetch(`${base}/steps/3/verify`, { method: "POST" })
    const [v1, v2] = await Promise.all([verify(), verify()])
    assert.deepEqual([v1.status, v2.status].sort(), [200, 409])
    assert.equal(started.calls.filter((call) => call.stepIndex === 3).length, 1, "one verify, one report")
  } finally {
    agent?.shutdown()
    await staged.cleanup()
  }
})

test("/ready is 200 while setup is still running and 500 with phase=failed when setup fails", async () => {
  const staged = await stageScenario()
  await writeFile(resolve(staged.scenarioDir, "scripts/setup.sh"), "#!/usr/bin/env bash\nsleep 2\nexit 1\n")
  let agent
  try {
    const started = await startAgent(staged.scenarioDir, { awaitSetup: false })
    agent = started.agent
    const { base } = started
    const during = await fetch(`${base}/ready`)
    const body = await during.json()
    assert.equal(during.status, 200)
    assert.equal(body.phase, "ready")
    assert.equal(body.ready, true)
    assert.equal(body.setup.status, "running")
    assert.equal(body.failure, null)
    assert.equal((await fetch(`${base}/steps/setup`).then((r) => r.json())).status, "running")

    const terminal = await openTerminal(base)
    terminal.ws.send("echo during-setup-$((1+1))\n")
    await sleep(500)
    assert.match(terminal.read(), /during-setup-2/, "the terminal is usable before setup finishes")
    terminal.ws.close()

    await agent.settled()
    const after = await fetch(`${base}/ready`)
    const failed = await after.json()
    assert.equal(after.status, 500)
    assert.equal(failed.phase, "failed")
    assert.equal(failed.ready, false)
    assert.equal(failed.setup.status, "failed")
    assert.equal(failed.failure.component, "setup")
  } finally {
    agent?.shutdown()
    await staged.cleanup()
  }
})

test("terminal ids are validated, capped at 8, and the dev page is off under the dispatcher", async () => {
  const staged = await stageScenario()
  let agent
  try {
    const started = await startAgent(staged.scenarioDir, { devPage: false })
    agent = started.agent
    const { base } = started
    const connectRaw = async (id) => {
      const { connect } = await import("node:net")
      const { once } = await import("node:events")
      const socket = connect(started.port, "127.0.0.1")
      await once(socket, "connect")
      socket.write(
        `GET /pty?id=${id} HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
      )
      const [data] = await once(socket, "data")
      return { status: data.toString().match(/^HTTP\/1\.1 (\d+)/)[1], socket }
    }
    assert.equal((await connectRaw("bad%20id")).status, "400")
    assert.equal((await connectRaw("x".repeat(17))).status, "400")
    const open = []
    for (let index = 1; index <= 8; index += 1) open.push(await openTerminal(base, `t${index}`))
    assert.equal((await connectRaw("t9")).status, "429")
    const reattach = await connectRaw("t1")
    assert.equal(reattach.status, "101", "an existing id reattaches even at the cap")
    reattach.socket.destroy()
    for (const terminal of open) terminal.ws.close()

    assert.equal((await fetch(`${base}/`)).status, 404)
    assert.equal((await fetch(`${base}/terminal.html`)).status, 404)
  } finally {
    agent?.shutdown()
    await staged.cleanup()
  }
})

test("reporter aborts hung requests and does not retry Convex application errors", async () => {
  let attempts = 0
  const hanging = createReporter({
    convexUrl: "https://example.convex.cloud",
    sessionId: "s1",
    sessionToken: "tok",
    logger: quiet,
    attemptTimeoutMs: 40,
    totalTimeoutMs: 150,
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        attempts += 1
        init.signal.addEventListener("abort", () => reject(init.signal.reason))
      }),
  })
  const startedAt = Date.now()
  const result = await hanging.recordStepResult({ stepIndex: 1, passed: true, output: "" })
  assert.equal(result.reported, false)
  assert.match(result.error, /timed out/)
  assert.ok(attempts >= 1 && attempts <= 3, `attempts: ${attempts}`)
  assert.ok(Date.now() - startedAt < 1500, "bounded by the total deadline")

  let calls = 0
  const appError = createReporter({
    convexUrl: "https://example.convex.cloud",
    sessionId: "s1",
    sessionToken: "tok",
    logger: quiet,
    fetchImpl: async () => {
      calls += 1
      return { ok: true, status: 200, json: async () => ({ status: "error", errorMessage: "Session agent authorization failed" }) }
    },
  })
  const denied = await appError.recordStepResult({ stepIndex: 1, passed: true, output: "" })
  assert.deepEqual(denied, { reported: false, error: "Session agent authorization failed" })
  assert.equal(calls, 1, "application errors are not retried")
})
