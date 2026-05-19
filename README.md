# Learning Lab Platform

Browser-based coding labs backed by Convex for control-plane state and AWS for disposable execution environments.

The first target lab is the React rendering optimization exercise at:

`/Users/stratus/dev/react/sen-cert/ch2-Rendering-Optimization/5-Optimize-Product-Dashboard/`

## Initial Architecture

- React/Vite frontend for the learner/admin UI.
- Convex schema and functions for labs, sessions, and session events.
- Lab manifests under `lab-definitions/`.
- AWS runner integration isolated under `runner/` and `infra/`.

The first runnable lab should be container-backed: a Node workspace, browser editor, Vite preview, terminal, and a `Check` action that runs Vitest. Kubernetes deployment should be an extension step, not the first platform dependency.

## Local Setup

```bash
npm install
cp .env.example .env.local
npx convex dev
npm run dev
```

After `convex dev` starts, set `VITE_CONVEX_URL` in `.env.local` to the URL it prints.

Docker Desktop must be running before processing sessions because the default local editor provider starts OpenVSCode with `gitpod/openvscode-server:latest`.

## Import The First React Lab

```bash
npm run import:react-lab
```

This copies the starter and solution exercise folders into `lab-definitions/react-product-dashboard/workspace-template/` so runner experiments can mount or package them without depending on the original path.

## Control Plane

Convex owns durable state:

- lab definitions
- learner sessions
- runner status
- validation results
- event timeline

AWS owns ephemeral execution:

- one session container/task per learner
- workspace filesystem
- Vite preview
- terminal/editor processes
- validation command execution

## Complete Local MVP Workflow

1. Start Convex: `npx convex dev`.
2. Start the dashboard: `npm run dev`.
3. Confirm Docker Desktop is running.
4. Open the dashboard and click `Seed lab`.
5. Click `Request session`.
6. Process sessions with `npm run runner:local` or `npm run runner:local:once`.
7. Open the session detail links:
   - `Workspace` opens OpenVSCode.
   - `Preview` opens the Vite app.
   - `Tools` opens validation controls.
8. Use `Run checks` from either the dashboard or tools page.
9. Use `Stop` from the dashboard to request cleanup, then run the local runner so it stops Docker/process resources.

## Run The Local Runner

After Convex is configured and the lab is seeded from the UI:

```bash
npm run runner:local
```

For a one-shot poll:

```bash
npm run runner:local:once
```

The runner processes requested local sessions, creates a workspace under `lab-workspaces/`, installs dependencies, starts OpenVSCode, starts Vite preview, starts the tools/check server, runs the Vitest validation command, and writes the score back to Convex.

By default, the local runner expects Docker Desktop and starts OpenVSCode with `gitpod/openvscode-server:latest`. To use a native OpenVSCode binary instead, set:

```bash
LOCAL_EDITOR_PROVIDER=openvscode-native
OPENVSCODE_SERVER_BIN=/path/to/openvscode-server
```

## Session Cleanup

The dashboard `Stop` button marks the session as stopped in Convex. The local runner performs actual cleanup on its next poll:

- stops the Vite preview process
- stops the tools server process
- stops the OpenVSCode Docker container
- records cleanup metadata in Convex

Expired sessions are handled the same way. The runner marks them `expired`, cleans local resources, and records a cleanup event.

## Troubleshooting

- Docker socket permission errors: run the runner with Docker access, confirm Docker Desktop is started, and verify `docker info` works.
- Port already in use: the local runner scans for the next available port near the deterministic session port; rerun the runner if a stale process still occupies a port.
- OpenVSCode image pull/start failures: run `docker pull gitpod/openvscode-server:latest`, or switch to `LOCAL_EDITOR_PROVIDER=openvscode-native`.
- Convex URL mismatch: confirm `.env.local` has the same `VITE_CONVEX_URL` printed by `npx convex dev`.
- Stale sessions/containers: click `Stop`, run `npm run runner:local:once`, then verify with `docker ps`.
