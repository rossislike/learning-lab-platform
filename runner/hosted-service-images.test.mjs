import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const dispatcherDockerfile = await readFile(
  new URL("./hosted-dispatcher.Dockerfile", import.meta.url),
  "utf8",
)
const gatewayDockerfile = await readFile(
  new URL("./hosted-session-gateway.Dockerfile", import.meta.url),
  "utf8",
)
const dispatcherDockerIgnore = await readFile(
  new URL("./hosted-dispatcher.Dockerfile.dockerignore", import.meta.url),
  "utf8",
)
const gatewayDockerIgnore = await readFile(
  new URL("./hosted-session-gateway.Dockerfile.dockerignore", import.meta.url),
  "utf8",
)
const learnerDockerfile = await readFile(
  new URL("./hosted-learner-session.Dockerfile", import.meta.url),
  "utf8",
)
const rootDockerIgnore = await readFile(
  new URL("../.dockerignore", import.meta.url),
  "utf8",
)
const rootPackageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
)
const dispatcherPackageJson = JSON.parse(
  await readFile(
    new URL("./dispatcher-runtime/package.json", import.meta.url),
    "utf8",
  ),
)
const dispatcherPackageLock = JSON.parse(
  await readFile(
    new URL("./dispatcher-runtime/package-lock.json", import.meta.url),
    "utf8",
  ),
)

test("dispatcher image contains only its trusted runtime entrypoint", () => {
  assert.match(dispatcherDockerfile, / AS build/)
  assert.match(dispatcherDockerfile, /npm ci/)
  assert.match(dispatcherDockerfile, /node_modules\/\.bin\/esbuild/)
  assert.match(dispatcherDockerfile, /createRequire\(import\.meta\.url\)/)
  assert.match(dispatcherDockerfile, /--bundle/)
  assert.match(dispatcherDockerfile, / AS runtime/)
  assert.match(dispatcherDockerfile, /USER node/)
  assert.match(dispatcherDockerfile, /ENTRYPOINT \["node", "dispatcher\.mjs"\]/)
  const runtimeStage = dispatcherDockerfile.split(" AS runtime")[1]
  assert.match(runtimeStage, /COPY --from=build/)
  assert.doesNotMatch(runtimeStage, /npm ci|node_modules|package-lock/)
  assert.doesNotMatch(dispatcherDockerfile, /lab-definitions|src\//)
})

test("gateway image is an independent non-root health-checked runtime", () => {
  assert.match(gatewayDockerfile, /USER node/)
  assert.match(gatewayDockerfile, /EXPOSE 8080/)
  assert.match(gatewayDockerfile, /HEALTHCHECK/)
  assert.match(
    gatewayDockerfile,
    /ENTRYPOINT \["node", "runner\/session-gateway\.mjs"\]/,
  )
  assert.doesNotMatch(gatewayDockerfile, /aws-runner|lab-definitions|src\//)
})

test("service images use the supported pinned Node 24 LTS ARM64 index", () => {
  const pinnedBase =
    "node:24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03"
  for (const dockerfile of [dispatcherDockerfile, gatewayDockerfile]) {
    assert.match(dockerfile, new RegExp(pinnedBase))
    assert.doesNotMatch(dockerfile, /node:20/)
  }
})

test("service build contexts are strict source allowlists", () => {
  assert.equal(dispatcherDockerIgnore.split("\n")[0], "**")
  for (const path of [
    "!convex/_generated/api.js",
    "!runner/dispatcher-runtime/package.json",
    "!runner/dispatcher-runtime/package-lock.json",
    "!runner/aws-runner.mjs",
    "!runner/aws-ecs-fargate-runner.mjs",
    "!runner/startup-cancellation.mjs",
  ]) {
    assert.match(dispatcherDockerIgnore, new RegExp(`^${path}$`, "m"))
  }
  assert.equal(gatewayDockerIgnore.split("\n")[0], "**")
  assert.match(gatewayDockerIgnore, /^!runner\/session-gateway\.mjs$/m)
  assert.match(
    gatewayDockerIgnore,
    /^!runner\/hosted-session-gateway-healthcheck\.mjs$/m,
  )
})

test("root image contexts exclude common local credential files", () => {
  for (const pattern of [
    "**/.aws",
    "**/.env",
    "**/.env.*",
    "**/.npmrc",
    "**/*backend*.hcl",
    "**/*.tfbackend",
    "**/*.tfvars",
    "**/*.tfvars.json",
    "**/credentials",
    "**/*.key",
    "**/*.pem",
  ]) {
    assert.match(rootDockerIgnore, new RegExp(`^${pattern.replaceAll("*", "\\*")}$`, "m"))
  }
})

test("learner image omits trusted dispatcher dependencies", () => {
  assert.match(learnerDockerfile, /npm ci --omit=dev/)
  assert.doesNotMatch(
    learnerDockerfile,
    /aws-ecs-fargate-runner|aws-runner|dispatcher-runtime/,
  )
  assert.equal(rootPackageJson.dependencies["@aws-sdk/client-ecs"], undefined)
  assert.equal(
    rootPackageJson.devDependencies["@aws-sdk/client-ecs"],
    "^3.1084.0",
  )
})

test("AWS SDK is available in production dispatcher installs", () => {
  assert.equal(
    dispatcherPackageJson.dependencies["@aws-sdk/client-ecs"],
    "3.1084.0",
  )
  assert.equal(dispatcherPackageJson.dependencies.convex, "1.43.0")
  assert.equal(dispatcherPackageJson.devDependencies.esbuild, "0.28.1")
  assert.equal(rootPackageJson.dependencies["@aws-sdk/client-ecs"], undefined)
  assert.equal(
    dispatcherPackageLock.packages["node_modules/@aws-sdk/client-ecs"].version,
    "3.1084.0",
  )
})
