# Session Runner

The runner is the boundary between Convex control-plane state and AWS execution.

## Contract

- `start`: create a disposable workspace for one session and return URLs.
- `check`: run the lab validation command and return structured results.
- `stop`: terminate compute and discard workspace state.

## First Implementation

Start with a local runner for fast iteration:

- copy `lab-definitions/.../workspace-template` into `lab-workspaces/<sessionId>`
- run `npm ci`
- start Vite
- expose OpenVSCode as the editor process
- expose a lightweight tools server for validation
- run Vitest on demand

Run it once:

```bash
npm run runner:local:once
```

Run it as a polling worker:

```bash
npm run runner:local
```

The local runner currently processes Convex sessions with `status: requested` and `runner: local`. It copies the lab template, runs `npm ci`, starts a per-session Vite preview, starts OpenVSCode for editing, starts a small per-session tools/check server, and marks the session `running`. Validation is intentionally user-triggered from the dashboard or tools page after the learner is ready.

The OpenVSCode URL is saved as `workspaceUrl`, the Vite URL is saved as `previewUrl`, and the tools/check URL is saved as `terminalUrl` for now.

Editor providers:

- `LOCAL_EDITOR_PROVIDER=openvscode-docker` starts `gitpod/openvscode-server:latest` in Docker. Docker Desktop must be running. Generated lab workspaces launch with Workspace Trust prompts disabled.
- `LOCAL_EDITOR_PROVIDER=openvscode-native` starts `OPENVSCODE_SERVER_BIN` or `openvscode-server` directly with Workspace Trust prompts disabled.
- `LOCAL_EDITOR_PROVIDER=lightweight` uses the older built-in textarea editor, mainly as an explicit debugging fallback.

## AWS Implementation

The AWS dispatcher implements the same session lifecycle boundary and launches
one ECS Fargate task per learner session. The local runner commands and behavior
remain unchanged.

Run the dispatcher once:

```bash
npm run runner:aws:once
```

Run it as a polling worker:

```bash
npm run runner:aws
```

The dispatcher reads the `AWS_ECS_*` values documented in `.env.example`, sends
the session ID, lab slug, template path, validation command, TTL, runner mode,
and Convex URL to the configured task container, and records the returned ECS
task ARN. The task agent is responsible for provisioning the workspace and
publishing editor, preview, and tools URLs through `sessions.updateRunnerMetadata` and
`sessions.markRunning`. This keeps routing and workspace storage independent of
the runner lifecycle contract.

The dispatcher host must have AWS CLI v2 installed and credentials that allow
`ecs:RunTask`, `ecs:ListTasks`, `ecs:StopTask`, `ecs:TagResource`, and
`iam:PassRole` for the configured task definition and roles.

Recommended task shape:

- Node 20 base image with runner agent and OpenVSCode installed in the image.
- Ephemeral workspace volume.
- Environment variables for Convex deployment URL and session ID.
- Fixed internal ports exposed through the session gateway: OpenVSCode on
  `3000`, Vite preview on `5173`, and tools on `8080`.
- No Docker daemon in the learner container for the first React lab.

The production learner-session image is defined by
[`hosted-learner-session.Dockerfile`](hosted-learner-session.Dockerfile). It
starts OpenVSCode, the scenario Vite preview, and the tools/check server inside
one unprivileged container. Build it with an explicit OpenVSCode release version
and SHA-256 checksum:

```bash
docker build --platform linux/arm64 \
  -f runner/hosted-learner-session.Dockerfile \
  --build-arg OPENVSCODE_SERVER_VERSION='<release-version>' \
  --build-arg OPENVSCODE_SERVER_SHA256='<release-tarball-sha256>' \
  -t "${ECR_HOST}/learning-lab-platform-staging-runner:${IMAGE_TAG}" .
```

Run the executable image smoke after supplying the same pinned release inputs:

```bash
OPENVSCODE_SERVER_VERSION='<release-version>' \
OPENVSCODE_SERVER_SHA256='<release-tarball-sha256>' \
npm run hosted:image:smoke
```

The smoke builds the ARM64 image, starts all three services, runs the starter
Vitest checks through the tools API, confirms that solution templates are not
present, and checks that learner processes do not inherit the runner secret.

When the image is promoted to a boundary-enabled staging or production task
definition, set its runtime contract to:

```hcl
runner_image_kind = "learner-session"
```

The module then selects the learner entrypoint, maps all three service ports,
and configures the ECS container health check. Keep `validation` for the earlier
scenario validation image. Hosted learner tasks must also receive gateway-owned
`LAB_EDITOR_URL`, `LAB_PREVIEW_URL`, and `LAB_TOOLS_URL` values. The image
rejects loopback publication in hosted mode.

The current dispatcher still injects `RUNNER_SHARED_SECRET` into the trusted
image supervisor. The supervisor deletes the JavaScript environment entry and
does not copy it into the editor, preview, dependency install, tools, or
validation environments. It passes the value once to the tools callback service
over stdin. Linux can retain an initial PID environment in `/proc`, so this is
defense in depth rather than a complete same-container secret boundary. The
roadmap item for the session-bound callback protocol remains open and must
replace the reusable secret before hosted learner traffic is enabled.

For the Kubernetes extension path, build and push images to ECR from a controlled builder service, then deploy to a per-session namespace. Do not use the Docker Desktop `ctr images import` workflow in AWS.
