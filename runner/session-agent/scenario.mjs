// Scenario bundle access for the agent: manifest, workspace preparation, and
// running the manifest's bash scripts exactly as docs/scenario-authoring.md
// specifies (bash, cwd = workspace.cwd, LAB_* environment).

import { spawn } from "node:child_process"
import { access, cp, mkdir, readFile, readdir } from "node:fs/promises"
import { constants } from "node:fs"
import { relative, resolve } from "node:path"
import process from "node:process"

const SCRIPT_PATTERN = /^scripts\/[a-z0-9-]+\.sh$/
const DEFAULT_SCRIPT_TIMEOUT_MS = 10 * 60 * 1000
const MAX_CAPTURED_OUTPUT = 64 * 1024
const DEFAULT_TABS = { terminal: ["terminal"], react: ["terminal", "editor", "preview"] }
const DEFAULT_WORKSPACE_ROOTS = "/workspace,/home,/tmp"
// Only these reach learner shells and scripts (plus LAB_* and anything named
// in AGENT_LEARNER_ENV_PASSTHROUGH). Everything else — SESSION_TOKEN,
// CONVEX_*, AWS_*, KUBERNETES_*, npm tokens, whatever the pod spec adds —
// stays with the agent.
const LEARNER_ENV_ALLOWLIST = new Set([
  "PATH", "HOME", "TERM", "LANG", "SHELL", "USER", "LOGNAME", "TZ", "COLORTERM",
])

export class ScenarioError extends Error {}

export async function loadScenario(scenarioDir) {
  const manifestPath = resolve(scenarioDir, "manifest.json")
  let manifest
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  } catch (error) {
    throw new ScenarioError(`cannot read ${manifestPath}: ${error.message}`)
  }
  if (manifest.schemaVersion !== 2) {
    throw new ScenarioError(`manifest schemaVersion must be 2 (got ${manifest.schemaVersion})`)
  }
  for (const field of ["slug", "kind", "workspace", "steps"]) {
    if (manifest[field] === undefined) throw new ScenarioError(`manifest is missing ${field}`)
  }
  if (!["terminal", "react"].includes(manifest.kind)) {
    throw new ScenarioError(`unsupported scenario kind ${manifest.kind}`)
  }
  if (typeof manifest.workspace?.cwd !== "string" || !manifest.workspace.cwd.startsWith("/")) {
    throw new ScenarioError("manifest workspace.cwd must be an absolute path")
  }
  const cwd = resolve(manifest.workspace.cwd)
  const roots = allowedWorkspaceRoots()
  if (!roots.some((root) => cwd === root || cwd.startsWith(`${root}/`))) {
    throw new ScenarioError(`manifest workspace.cwd must be under one of ${roots.join(", ")} (got ${cwd})`)
  }
  for (const script of [manifest.setup, ...manifest.steps.flatMap((step) => [step.setup, step.verify])]) {
    if (script !== undefined && !SCRIPT_PATTERN.test(script)) {
      throw new ScenarioError(`invalid script path ${script}`)
    }
  }
  return {
    dir: scenarioDir,
    manifest,
    slug: manifest.slug,
    kind: manifest.kind,
    tabs: manifest.tabs ?? DEFAULT_TABS[manifest.kind],
    cwd,
    user: manifest.workspace.user ?? "learner",
    steps: manifest.steps,
    react: manifest.react,
  }
}

export function scriptEnvironment(scenario, extra = {}) {
  return {
    ...baseEnvironment(),
    LAB_WORKSPACE: scenario.cwd,
    LAB_SCENARIO_DIR: scenario.dir,
    LAB_SCENARIO_SLUG: scenario.slug,
    ...extra,
  }
}

/** Directories workspace.cwd may live under (AGENT_ALLOWED_WORKSPACE_ROOTS, comma list). */
export function allowedWorkspaceRoots() {
  return (process.env.AGENT_ALLOWED_WORKSPACE_ROOTS ?? DEFAULT_WORKSPACE_ROOTS)
    .split(",")
    .map((root) => root.trim())
    .filter((root) => root.startsWith("/"))
    .map((root) => resolve(root))
}

/** Environment handed to learner shells and scripts: an allowlist, no agent secrets. */
export function baseEnvironment() {
  const passthrough = new Set(
    (process.env.AGENT_LEARNER_ENV_PASSTHROUGH ?? "").split(",").map((name) => name.trim()).filter(Boolean),
  )
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (LEARNER_ENV_ALLOWLIST.has(key) || key.startsWith("LC_") || key.startsWith("LAB_") || passthrough.has(key)) {
      env[key] = value
    }
  }
  env.PATH ??= "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  env.TERM ??= "xterm-256color"
  env.LANG ??= "C.UTF-8"
  // The image sets HOME=/home/learner; a root PTY (workspace.user: root,
  // runAsUser 0) must not inherit it or git/npm write to the wrong place.
  env.HOME = process.getuid?.() === 0 ? "/root" : (process.env.HOME ?? "/home/learner")
  return env
}

async function pathExists(path) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/** Copies workspace/ from a react bundle into the workspace cwd, once. */
export async function prepareWorkspace(scenario, { logger = console } = {}) {
  await mkdir(scenario.cwd, { recursive: true })
  await mkdir(baseEnvironment().HOME, { recursive: true }).catch(() => {})
  if (scenario.kind !== "react") return { copied: false }
  const source = resolve(scenario.dir, "workspace")
  if (!(await pathExists(source))) {
    throw new ScenarioError("react scenario bundle has no workspace/ directory")
  }
  const existing = await readdir(scenario.cwd)
  if (existing.length > 0) {
    logger.info?.(`[scenario] workspace ${scenario.cwd} is not empty; keeping it`)
    return { copied: false }
  }
  await cp(source, scenario.cwd, {
    recursive: true,
    filter: (path) => !/\/(node_modules|dist)(\/|$)/.test(path),
  })
  return { copied: true }
}

function truncate(text) {
  return text.length > MAX_CAPTURED_OUTPUT ? `${text.slice(-MAX_CAPTURED_OUTPUT)}` : text
}

/**
 * Runs one manifest script. Resolves (never rejects) with
 * { code, stdout, stderr, durationMs, timedOut }.
 */
export function runScript(scenario, scriptPath, { stepIndex, timeoutMs = DEFAULT_SCRIPT_TIMEOUT_MS } = {}) {
  if (!SCRIPT_PATTERN.test(scriptPath)) {
    return Promise.resolve({ code: 1, stdout: "", stderr: `invalid script path ${scriptPath}`, durationMs: 0, timedOut: false })
  }
  const absolute = resolve(scenario.dir, scriptPath)
  if (relative(scenario.dir, absolute).startsWith("..")) {
    return Promise.resolve({ code: 1, stdout: "", stderr: `script escapes the scenario: ${scriptPath}`, durationMs: 0, timedOut: false })
  }
  const startedAt = Date.now()
  return new Promise((resolveRun) => {
    // Own process group so a timeout kills the script's children too.
    const child = spawn("bash", [absolute], {
      cwd: scenario.cwd,
      env: scriptEnvironment(scenario, stepIndex ? { LAB_STEP: String(stepIndex) } : {}),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        process.kill(-child.pid, "SIGKILL")
      } catch {
        child.kill("SIGKILL")
      }
    }, timeoutMs)
    child.stdout.on("data", (chunk) => {
      stdout = truncate(stdout + chunk)
    })
    child.stderr.on("data", (chunk) => {
      stderr = truncate(stderr + chunk)
    })
    const finish = (code, error) => {
      clearTimeout(timer)
      resolveRun({
        code: error ? 1 : (code ?? 1),
        stdout,
        stderr: error ? `${stderr}${error.message}` : stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
      })
    }
    child.on("error", (error) => finish(1, error))
    child.on("close", (code) => finish(code))
  })
}
