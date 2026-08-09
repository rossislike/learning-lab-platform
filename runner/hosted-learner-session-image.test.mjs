import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import test from "node:test"

const dockerfile = await readFile(
  new URL("./hosted-learner-session.Dockerfile", import.meta.url),
  "utf8",
)
const entrypoint = await readFile(
  new URL("./hosted-learner-entrypoint.mjs", import.meta.url),
  "utf8",
)
const healthcheck = await readFile(
  new URL("./hosted-learner-healthcheck.mjs", import.meta.url),
  "utf8",
)
const workspaceServer = await readFile(
  new URL("./workspace-server.mjs", import.meta.url),
  "utf8",
)

test("production learner image installs pinned OpenVSCode without Docker-in-Docker", () => {
  assert.match(
    dockerfile,
    /^FROM node:20-bookworm-slim@sha256:[0-9a-f]{64} AS runtime$/m,
  )
  assert.match(dockerfile, /ARG OPENVSCODE_SERVER_VERSION/)
  assert.match(dockerfile, /ARG OPENVSCODE_SERVER_SHA256/)
  assert.match(dockerfile, /sha256sum -c -/)
  assert.match(dockerfile, /USER node/)
  assert.doesNotMatch(dockerfile, /docker\.sock|dind|privileged|docker run/i)
})

test("production learner image exposes fixed gateway ports and healthcheck", () => {
  assert.match(dockerfile, /ENV LAB_EDITOR_PORT=3000/)
  assert.match(dockerfile, /ENV LAB_PREVIEW_PORT=5173/)
  assert.match(dockerfile, /ENV LAB_TOOLS_PORT=8080/)
  assert.match(dockerfile, /EXPOSE 3000 5173 8080/)
  assert.match(dockerfile, /HEALTHCHECK/)
  assert.match(dockerfile, /hosted-learner-healthcheck\.mjs/)
  assert.match(healthcheck, /LAB_EDITOR_PORT \?\? 3000/)
  assert.match(healthcheck, /LAB_PREVIEW_PORT \?\? 5173/)
  assert.match(healthcheck, /LAB_TOOLS_PORT \?\? 8080/)
  assert.match(healthcheck, /\/api\/health/)
})

test("entrypoint starts editor, preview, and tools on fixed internal ports", () => {
  assert.match(entrypoint, /"openvscode-server"/)
  assert.match(entrypoint, /"--host",\s+"0\.0\.0\.0"/)
  assert.match(entrypoint, /"--port",\s+String\(editorPort\)/)
  assert.match(entrypoint, /"npm",\s+\[\s*"run",\s+"dev"/)
  assert.match(entrypoint, /"--port",\s+String\(previewPort\)/)
  assert.match(entrypoint, /resolve\(appRoot, "runner\/workspace-server\.mjs"\)/)
  assert.match(entrypoint, /"--mode",\s+"tools"/)
  assert.match(entrypoint, /"--port",\s+String\(toolsPort\)/)
  assert.match(entrypoint, /__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS/)
})

test("entrypoint copies only in-repository templates without deleting workspace root", () => {
  assert.match(entrypoint, /const labDefinitionsRoot = resolve\(appRoot, "lab-definitions"\)/)
  assert.match(entrypoint, /relative\(labDefinitionsRoot, target\)/)
  assert.match(entrypoint, /LAB_WORKSPACE_TEMPLATE_PATH must point inside lab-definitions/)
  assert.match(entrypoint, /async function clearWorkspace\(\)/)
  assert.match(entrypoint, /readdir\(workspaceRoot, \{ withFileTypes: true \}\)/)
  assert.doesNotMatch(entrypoint, /rm\(workspaceRoot/)
  assert.match(dockerfile, /COPY --from=templates/)
  assert.doesNotMatch(dockerfile, /COPY --chown=node:node lab-definitions lab-definitions/)
})

test("entrypoint publishes session readiness and errors to Convex", () => {
  assert.match(entrypoint, /api\.sessions\.updateRunnerMetadata/)
  assert.match(entrypoint, /api\.sessions\.markRunning/)
  assert.match(entrypoint, /api\.sessions\.markErrored/)
  assert.match(entrypoint, /editorProvider: "openvscode-container"/)
  assert.match(entrypoint, /LAB_VALIDATION_COMMAND/)
  assert.match(entrypoint, /requiredHostedUrl\("LAB_EDITOR_URL"\)/)
  assert.match(entrypoint, /requiredHostedUrl\("LAB_PREVIEW_URL"\)/)
  assert.match(entrypoint, /requiredHostedUrl\("LAB_TOOLS_URL"\)/)
  assert.doesNotMatch(entrypoint, /LAB_EDITOR_URL \?\? `http:\/\/127\.0\.0\.1/)
})

test("tools server can bind to the Fargate network interface", () => {
  assert.match(workspaceServer, /args\.get\("--host"\)/)
  assert.match(workspaceServer, /WORKSPACE_SERVER_HOST/)
  assert.match(workspaceServer, /server\.listen\(port, host/)
  assert.match(workspaceServer, /\/api\/health/)
  assert.match(workspaceServer, /learnerProcessEnv\(process\.env, \{ NODE_ENV: "test" \}\)/)
})

test("workspace install includes dev dependencies and learner children omit the shared secret", () => {
  assert.match(entrypoint, /\["ci", "--include=dev"\]/)
  assert.match(entrypoint, /delete process\.env\.RUNNER_SHARED_SECRET/)
  assert.match(entrypoint, /learnerProcessEnv\(process\.env, extraEnv\)/)
  assert.doesNotMatch(entrypoint, /RUNNER_SHARED_SECRET: runnerSecret/)
  assert.match(entrypoint, /RUNNER_SECRET_STDIN: "1"/)
  assert.match(workspaceServer, /await readRunnerSecret\(\)/)
  assert.match(workspaceServer, /delete process\.env\.RUNNER_SHARED_SECRET/)
})

test("hosted entrypoint fails closed without gateway URLs", () => {
  const environment = {
    ...process.env,
    LAB_SESSION_ID: "url-test",
    LAB_WORKSPACE_TEMPLATE_PATH:
      "lab-definitions/react-welcome-message/workspace-template/update-welcome-message-1",
    CONVEX_URL: "https://example.convex.cloud",
    RUNNER_SHARED_SECRET: "test-secret",
  }
  delete environment.LAB_EDITOR_URL
  delete environment.LAB_PREVIEW_URL
  delete environment.LAB_TOOLS_URL

  const result = spawnSync(
    process.execPath,
    [new URL("./hosted-learner-entrypoint.mjs", import.meta.url).pathname],
    { encoding: "utf8", env: environment },
  )

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /LAB_EDITOR_URL is required/)
})
