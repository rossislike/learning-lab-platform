# Runner

`runner/` holds the legacy local Docker runner plus the pieces that survive
into the Kubernetes design (ADR 0005). The session agent, the Kubernetes
dispatcher, and the real session gateway arrive in ROADMAP Phases 2–3; the
legacy local runner is deleted at the end of Phase 3.

## What is here today

| File | Purpose |
|---|---|
| `local-runner.mjs` | Legacy local runner. Polls Convex for sessions with `status: requested` and `runner: local`, copies the lab template into `lab-workspaces/<sessionId>`, runs `npm ci`, starts a Vite preview, an OpenVSCode editor, and a per-session workspace/tools server, then marks the session `running`. |
| `workspace-server.mjs` | The per-session tools/check HTTP server the local runner starts (runs the validation command on demand). |
| `session-gateway.mjs` | Stub gateway. Answers health checks and returns `503 gateway-deployment-pending` for everything else; implemented for real in Phase 3 (ADR 0004). |
| `session-runner.ts` | Shared runner lifecycle types (`start` / `check` / `stop` contract). |
| `startup-cancellation.mjs` | Helper for cancelling a session that is stopped while it is still starting. |
| `package-learner-templates.mjs` | Packages lab workspace templates for a session (solution files excluded). |
| `learner-process-env.mjs` | Builds the environment handed to learner-facing processes without the runner secret. Used by `workspace-server.mjs`. |

Each `.mjs` module has a sibling `*.test.mjs`; run them with `npm run test:runner`.

## Running the legacy local runner

Requires a Convex dev deployment (`npm run convex:dev`) and `RUNNER_SHARED_SECRET`
set to the same value in Convex and `.env.local`.

```bash
npm run runner:local        # polling worker
npm run runner:local:once   # process one requested session and exit
```

`npm run dev:all` starts Convex, Vite, and the runner together.

Editor providers (`LOCAL_EDITOR_PROVIDER`):

- `openvscode-docker` (default): starts `gitpod/openvscode-server:latest` in
  Docker. Docker Desktop must be running.
- `openvscode-native`: starts `OPENVSCODE_SERVER_BIN` (or `openvscode-server` on
  `PATH`) directly.
- `lightweight`: the built-in textarea editor, as a debugging fallback.

The OpenVSCode URL is saved on the session as `workspaceUrl`, the Vite URL as
`previewUrl`, and the tools/check URL as `terminalUrl`. Validation is
user-triggered from the UI.

## What comes next

- Phase 2: `runner/session-agent/` (PTY, step verify, editor/preview proxies)
  inside the `session-workspace` image.
- Phase 3: `runner/k8s-dispatcher.mjs` and a working `session-gateway.mjs`,
  deployed to kind locally and EKS in `dev` via the Helm chart.

See [`ROADMAP.md`](../ROADMAP.md) and
[ADR 0005](../docs/decisions/0005-kubernetes-execution-model.md).
