import { ConvexHttpClient } from "convex/browser"
import { spawn } from "node:child_process"
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { hostname } from "node:os"
import { resolve, relative } from "node:path"
import { api } from "../convex/_generated/api.js"
import { learnerProcessEnv } from "./learner-process-env.mjs"

const appRoot = resolve("/app")
const labDefinitionsRoot = resolve(appRoot, "lab-definitions")
const workspaceRoot = resolve(process.env.LAB_WORKSPACE_ROOT ?? "/workspace")
const sessionId = requiredEnv("LAB_SESSION_ID")
const templatePath = safeTemplatePath(requiredEnv("LAB_WORKSPACE_TEMPLATE_PATH"))
const imageSmokeMode = process.env.LAB_RUNNER_MODE === "image-smoke"
const convexUrl = imageSmokeMode ? undefined : requiredEnv("CONVEX_URL")
const runnerSecret = imageSmokeMode
  ? process.env.RUNNER_SHARED_SECRET
  : requiredEnv("RUNNER_SHARED_SECRET")
delete process.env.RUNNER_SHARED_SECRET
const labSlug = process.env.LAB_SLUG ?? "unknown-lab"
const validationCommand =
  process.env.LAB_VALIDATION_COMMAND ?? "npm test -- --run --reporter=json"
const editorPort = numberEnv("LAB_EDITOR_PORT", 3000)
const previewPort = numberEnv("LAB_PREVIEW_PORT", 5173)
const toolsPort = numberEnv("LAB_TOOLS_PORT", 8080)
const editorUrl = requiredHostedUrl("LAB_EDITOR_URL")
const previewUrl = requiredHostedUrl("LAB_PREVIEW_URL")
const toolsUrl = requiredHostedUrl("LAB_TOOLS_URL")
const previewHostname = new URL(previewUrl).hostname
const client = convexUrl ? new ConvexHttpClient(convexUrl) : null
const children = new Map()
let shuttingDown = false

function requiredEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} must be a valid TCP port`)
  }
  return value
}

function requiredHostedUrl(name) {
  const input = requiredEnv(name)
  let url
  try {
    url = new URL(input)
  } catch {
    throw new Error(`${name} must be a valid URL`)
  }
  if (!imageSmokeMode && url.protocol !== "https:") {
    throw new Error(`${name} must use https in hosted mode`)
  }
  if (!imageSmokeMode && ["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error(`${name} must use a gateway hostname in hosted mode`)
  }
  return url.toString()
}

function safeTemplatePath(inputPath) {
  const target = resolve(appRoot, inputPath)
  const rel = relative(labDefinitionsRoot, target)
  if (rel.startsWith("..") || rel === "" || target.includes("/node_modules/")) {
    throw new Error(
      "LAB_WORKSPACE_TEMPLATE_PATH must point inside lab-definitions",
    )
  }
  return target
}

async function prepareOpenVSCodeUserData() {
  const userSettingsDir = resolve(
    workspaceRoot,
    ".openvscode-server/data/User",
  )
  const userSettingsPath = resolve(userSettingsDir, "settings.json")
  const trustSettings = {
    "security.workspace.trust.enabled": false,
    "security.workspace.trust.startupPrompt": "never",
    "security.workspace.trust.untrustedFiles": "open",
    "security.workspace.trust.emptyWindow": false,
  }

  await mkdir(userSettingsDir, { recursive: true })

  let currentSettings = {}
  try {
    currentSettings = JSON.parse(await readFile(userSettingsPath, "utf8"))
  } catch {
    currentSettings = {}
  }

  await writeFile(
    userSettingsPath,
    `${JSON.stringify({ ...currentSettings, ...trustSettings }, null, 2)}\n`,
  )
}

function spawnManaged(
  name,
  command,
  args,
  cwd,
  extraEnv = {},
  stdinInput,
) {
  const child = spawn(command, args, {
    cwd,
    env: learnerProcessEnv(process.env, extraEnv),
    stdio: [stdinInput === undefined ? "ignore" : "pipe", "inherit", "inherit"],
  })

  if (stdinInput !== undefined) child.stdin.end(stdinInput)

  children.set(name, child)
  child.on("exit", (code, signal) => {
    children.delete(name)
    if (shuttingDown) return
    void failAndExit(
      `${name} exited unexpectedly with ${signal ?? `code ${code ?? 1}`}`,
    )
  })

  return child
}

async function waitForHttp(name, url, timeoutMs = 90000) {
  const startedAt = Date.now()
  let lastError = ""

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { redirect: "manual" })
      if (response.status >= 200 && response.status < 500) return
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000))
  }

  throw new Error(`${name} did not become healthy at ${url}: ${lastError}`)
}

async function publishRunning() {
  if (!client || !runnerSecret) return
  const metadataAccepted = await client.mutation(api.sessions.updateRunnerMetadata, {
    runnerSecret,
    sessionId,
    workspaceUrl: editorUrl,
    previewUrl,
    terminalUrl: toolsUrl,
    editorProvider: "openvscode-container",
    editorPort,
    previewPort,
    toolsPort,
    workspacePath: workspaceRoot,
  })
  if (!metadataAccepted) {
    throw new Error("Session no longer accepts runner metadata")
  }

  const runningAccepted = await client.mutation(api.sessions.markRunning, {
    runnerSecret,
    sessionId,
    workspaceUrl: editorUrl,
    previewUrl,
    terminalUrl: toolsUrl,
  })
  if (!runningAccepted) {
    throw new Error("Session no longer accepts running publication")
  }
}

async function markErrored(message) {
  if (!client || !runnerSecret) return
  try {
    await client.mutation(api.sessions.markErrored, {
      runnerSecret,
      sessionId,
      message,
      raw: {
        labSlug,
        hostname: hostname(),
        editorPort,
        previewPort,
        toolsPort,
      },
    })
  } catch (error) {
    console.error("[hosted-learner] failed to mark session errored", error)
  }
}

async function stopChildren(signal = "SIGTERM") {
  shuttingDown = true
  for (const child of children.values()) {
    if (child.exitCode === null && !child.killed) {
      child.kill(signal)
    }
  }
}

async function failAndExit(message) {
  console.error(`[hosted-learner] ${message}`)
  await markErrored(message)
  await stopChildren()
  process.exit(1)
}

async function installDependencies() {
  await new Promise((resolveInstall, rejectInstall) => {
    const child = spawn("npm", ["ci", "--include=dev"], {
      cwd: workspaceRoot,
      env: learnerProcessEnv(process.env, {
        NODE_ENV: "development",
        NPM_CONFIG_PRODUCTION: "false",
      }),
      stdio: ["ignore", "inherit", "inherit"],
    })
    child.on("exit", (code) => {
      if (code === 0) {
        resolveInstall()
      } else {
        rejectInstall(new Error(`npm ci exited with code ${code ?? 1}`))
      }
    })
    child.on("error", rejectInstall)
  })
}

async function clearWorkspace() {
  await mkdir(workspaceRoot, { recursive: true })
  const entries = await readdir(workspaceRoot, { withFileTypes: true })
  await Promise.all(
    entries.map((entry) =>
      rm(resolve(workspaceRoot, entry.name), { recursive: true, force: true }),
    ),
  )
}

async function main() {
  console.log(
    `[hosted-learner] preparing ${sessionId} from ${templatePath}`,
  )
  await clearWorkspace()
  await cp(templatePath, workspaceRoot, {
    recursive: true,
    filter: (path) =>
      !path.includes("/node_modules/") &&
      !path.endsWith("/node_modules") &&
      !path.includes("/dist/") &&
      !path.endsWith("/dist"),
  })
  await prepareOpenVSCodeUserData()
  await installDependencies()

  spawnManaged(
    "editor",
    "openvscode-server",
    [
      "--host",
      "0.0.0.0",
      "--port",
      String(editorPort),
      "--without-connection-token",
      "--disable-workspace-trust",
      "--user-data-dir",
      resolve(workspaceRoot, ".openvscode-server/data"),
      workspaceRoot,
    ],
    workspaceRoot,
    { NODE_ENV: "development" },
  )
  spawnManaged(
    "preview",
    "npm",
    ["run", "dev", "--", "--host", "0.0.0.0", "--port", String(previewPort)],
    workspaceRoot,
    {
      NODE_ENV: "development",
      __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: previewHostname,
    },
  )
  spawnManaged(
    "tools",
    "node",
    [
      resolve(appRoot, "runner/workspace-server.mjs"),
      "--mode",
      "tools",
      "--workspace",
      workspaceRoot,
      "--session-id",
      sessionId,
      "--host",
      "0.0.0.0",
      "--port",
      String(toolsPort),
      "--preview-url",
      previewUrl,
      "--editor-url",
      editorUrl,
      "--validation-command",
      validationCommand,
    ],
    appRoot,
    {
      ...(convexUrl ? { CONVEX_URL: convexUrl } : {}),
      ...(runnerSecret ? { RUNNER_SECRET_STDIN: "1" } : {}),
    },
    runnerSecret,
  )

  await waitForHttp("editor", `http://127.0.0.1:${editorPort}/`)
  await waitForHttp("preview", `http://127.0.0.1:${previewPort}/`)
  await waitForHttp("tools", `http://127.0.0.1:${toolsPort}/api/health`)
  await publishRunning()

  console.log(
    `[hosted-learner] session ${sessionId} is running on ports ${editorPort}, ${previewPort}, ${toolsPort}`,
  )
}

process.on("SIGTERM", () => {
  void stopChildren().then(() => process.exit(0))
})
process.on("SIGINT", () => {
  void stopChildren("SIGINT").then(() => process.exit(0))
})

main().catch((error) => {
  void failAndExit(error instanceof Error ? error.message : String(error))
})
