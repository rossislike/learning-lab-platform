import { spawn } from "node:child_process"

const releaseVersion = requiredEnv("OPENVSCODE_SERVER_VERSION")
const releaseSha256 = requiredEnv("OPENVSCODE_SERVER_SHA256")
const imageTag = `learning-lab-hosted-session-smoke:${process.pid}`
const containerName = `learning-lab-hosted-session-smoke-${process.pid}`
const editorPort = portEnv("HOSTED_SMOKE_EDITOR_PORT", 33000)
const previewPort = portEnv("HOSTED_SMOKE_PREVIEW_PORT", 35173)
const toolsPort = portEnv("HOSTED_SMOKE_TOOLS_PORT", 38080)

function requiredEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function portEnv(name, fallback) {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new Error(`${name} must be a port from 1024 through 65535`)
  }
  return value
}

function runDocker(args, { allowFailure = false } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("docker", args, {
      stdio: allowFailure ? ["ignore", "ignore", "ignore"] : "inherit",
    })
    child.on("error", rejectRun)
    child.on("close", (code) => {
      if (code === 0 || allowFailure) resolveRun(code ?? 1)
      else {
        rejectRun(
          new Error(
            `docker ${args.slice(0, 3).join(" ")} exited with code ${code ?? 1}`,
          ),
        )
      }
    })
  })
}

async function waitFor(name, url, timeoutMs = 180000) {
  const startedAt = Date.now()
  let lastError = "not attempted"
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url)
      if (response.ok) return response
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000))
  }
  throw new Error(`${name} was not ready at ${url}: ${lastError}`)
}

try {
  await runDocker([
    "build",
    "--quiet",
    "--platform",
    process.env.HOSTED_IMAGE_PLATFORM ?? "linux/arm64",
    "-f",
    "runner/hosted-learner-session.Dockerfile",
    "--build-arg",
    `OPENVSCODE_SERVER_VERSION=${releaseVersion}`,
    "--build-arg",
    `OPENVSCODE_SERVER_SHA256=${releaseSha256}`,
    "-t",
    imageTag,
    ".",
  ])

  await runDocker([
    "run",
    "--rm",
    "--detach",
    "--name",
    containerName,
    "-p",
    `127.0.0.1:${editorPort}:3000`,
    "-p",
    `127.0.0.1:${previewPort}:5173`,
    "-p",
    `127.0.0.1:${toolsPort}:8080`,
    "-e",
    "LAB_RUNNER_MODE=image-smoke",
    "-e",
    "RUNNER_SHARED_SECRET=image-smoke-secret",
    "-e",
    "LAB_SESSION_ID=image-smoke",
    "-e",
    "LAB_SLUG=react-welcome-message",
    "-e",
    "LAB_WORKSPACE_TEMPLATE_PATH=lab-definitions/react-welcome-message/workspace-template/update-welcome-message-1",
    "-e",
    "LAB_VALIDATION_COMMAND=node -e \"if(process.env.RUNNER_SHARED_SECRET)process.exit(1)\" && npm test -- --run --reporter=json",
    "-e",
    "LAB_EDITOR_URL=http://ed-image-smoke.example.test/",
    "-e",
    "LAB_PREVIEW_URL=http://pv-image-smoke.example.test/",
    "-e",
    "LAB_TOOLS_URL=http://tl-image-smoke.example.test/tools",
    imageTag,
  ])

  await Promise.all([
    waitFor("OpenVSCode", `http://127.0.0.1:${editorPort}/`),
    waitFor("Vite", `http://127.0.0.1:${previewPort}/`),
    waitFor("tools", `http://127.0.0.1:${toolsPort}/api/health`),
  ])

  const gatewayHostResponse = await fetch(`http://127.0.0.1:${previewPort}/`, {
    headers: { host: "pv-image-smoke.example.test" },
  })
  if (!gatewayHostResponse.ok) {
    throw new Error(
      `Vite rejected the assigned gateway host with HTTP ${gatewayHostResponse.status}`,
    )
  }

  const checkResponse = await fetch(`http://127.0.0.1:${toolsPort}/api/check`, {
    method: "POST",
  })
  const check = await checkResponse.json()
  if (!checkResponse.ok || !Array.isArray(check.assertions) || check.assertions.length === 0) {
    throw new Error(`Validation service did not run Vitest: ${JSON.stringify(check)}`)
  }

  await runDocker([
    "exec",
    containerName,
    "test",
    "!",
    "-e",
    "/app/lab-definitions/react-welcome-message/workspace-template/update-welcome-message-2",
  ])
  await runDocker([
    "exec",
    containerName,
    "node",
    "-e",
    "const fs=require('node:fs');const pids=fs.readdirSync('/proc').filter((name)=>/^\\d+$/.test(name)&&name!=='1'&&Number(name)!==process.pid);for(const pid of pids){try{const environment=fs.readFileSync('/proc/'+pid+'/environ','utf8');if(environment.includes('RUNNER_SHARED_SECRET='))process.exit(1)}catch{}}",
  ])
  console.log("[hosted-image-smoke] editor, preview, tools, and validation passed")
} finally {
  await runDocker(["rm", "--force", containerName], { allowFailure: true })
  await runDocker(["image", "rm", imageTag], { allowFailure: true })
}
