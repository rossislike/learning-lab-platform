import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execute = promisify(execFile)
const suffix = `${process.pid}-${Date.now()}`
const dispatcherImage = `learning-lab-dispatcher-smoke:${suffix}`
const gatewayImage = `learning-lab-session-gateway-smoke:${suffix}`
const gatewayPort = 32000 + Math.floor(Math.random() * 12000)
let gatewayContainer

async function docker(args, options = {}) {
  return execute("docker", args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  })
}

async function inspect(image) {
  const { stdout } = await docker(["image", "inspect", image])
  return JSON.parse(stdout)[0]
}

async function waitForGateway() {
  const deadline = Date.now() + 30_000
  let lastError
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/health`)
      if (response.ok) return response
      lastError = new Error(`Gateway health returned ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw lastError ?? new Error("Gateway did not become healthy")
}

try {
  console.log("[hosted-service-images-smoke] building dispatcher image")
  await docker([
    "build",
    "--platform",
    "linux/arm64",
    "-f",
    "runner/hosted-dispatcher.Dockerfile",
    "-t",
    dispatcherImage,
    ".",
  ])

  console.log("[hosted-service-images-smoke] building gateway image")
  await docker([
    "build",
    "--platform",
    "linux/arm64",
    "-f",
    "runner/hosted-session-gateway.Dockerfile",
    "-t",
    gatewayImage,
    ".",
  ])

  const [dispatcher, gateway] = await Promise.all([
    inspect(dispatcherImage),
    inspect(gatewayImage),
  ])
  if (dispatcher.Architecture !== "arm64" || gateway.Architecture !== "arm64") {
    throw new Error("Hosted service images must target ARM64")
  }
  if (dispatcher.Config.User !== "node" || gateway.Config.User !== "node") {
    throw new Error("Hosted service images must run as the node user")
  }
  if (dispatcher.Id === gateway.Id) {
    throw new Error("Dispatcher and gateway must be separate images")
  }
  if (!gateway.Config.Healthcheck?.Test?.includes(
    "runner/hosted-session-gateway-healthcheck.mjs",
  )) {
    throw new Error("Gateway image healthcheck is missing")
  }

  for (const image of [dispatcherImage, gatewayImage]) {
    const { stdout } = await docker([
      "run",
      "--rm",
      "--platform",
      "linux/arm64",
      "--entrypoint",
      "node",
      image,
      "--version",
    ])
    if (stdout.trim() !== "v24.19.0") {
      throw new Error(`${image} must use Node 24.19.0`)
    }
  }

  await docker([
    "run",
    "--rm",
    "--platform",
    "linux/arm64",
    "--entrypoint",
    "sh",
    dispatcherImage,
    "-c",
    "test -f /app/dispatcher.mjs && test ! -e /app/node_modules && test ! -e /app/runner && test ! -e /app/convex",
  ])

  try {
    await docker([
      "run",
      "--rm",
      "--platform",
      "linux/arm64",
      "-e",
      "RUNNER_SHARED_SECRET=image-smoke",
      "-e",
      "CONVEX_URL=https://example.convex.cloud",
      dispatcherImage,
      "--once",
    ])
    throw new Error("Dispatcher unexpectedly started without ECS configuration")
  } catch (error) {
    const stderr = error?.stderr ?? ""
    if (!stderr.includes("Missing AWS ECS runner configuration")) throw error
  }

  const { stdout } = await docker([
    "run",
    "-d",
    "--rm",
    "--platform",
    "linux/arm64",
    "-p",
    `127.0.0.1:${gatewayPort}:8080`,
    gatewayImage,
  ])
  gatewayContainer = stdout.trim()

  const health = await waitForGateway()
  const healthBody = await health.json()
  if (healthBody.status !== "healthy") {
    throw new Error("Gateway health response is invalid")
  }

  const denied = await fetch(`http://127.0.0.1:${gatewayPort}/workspace`)
  const deniedBody = await denied.json()
  if (
    denied.status !== 503 ||
    deniedBody.code !== "gateway-deployment-pending"
  ) {
    throw new Error("Gateway must fail closed for workspace traffic")
  }

  console.log(
    "[hosted-service-images-smoke] dispatcher and gateway image checks passed",
  )
} finally {
  if (gatewayContainer) {
    await docker(["stop", "--time", "5", gatewayContainer]).catch(() => {})
  }
  await Promise.all([
    docker(["image", "rm", "--force", dispatcherImage]).catch(() => {}),
    docker(["image", "rm", "--force", gatewayImage]).catch(() => {}),
  ])
}
