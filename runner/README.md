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

The AWS runner should launch one ECS Fargate task per learner session.

Recommended task shape:

- Node 20 base image with runner agent.
- Ephemeral workspace volume.
- Environment variables for Convex deployment URL and session ID.
- Vite preview port exposed through a session gateway.
- No Docker daemon in the learner container for the first React lab.

For the Kubernetes extension path, build and push images to ECR from a controlled builder service, then deploy to a per-session namespace. Do not use the Docker Desktop `ctr images import` workflow in AWS.
