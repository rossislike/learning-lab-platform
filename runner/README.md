# Runner

`runner/` holds the session agent (Phase 2, code complete; image build and
Docker integration run pending), the legacy local Docker runner, and the
pieces that survive into the Kubernetes design (ADR 0005). The Kubernetes
dispatcher and the real session gateway arrive in ROADMAP Phase 3; the legacy
local runner is deleted at the end of that phase.

## Session agent (`session-agent/`)

One agent runs inside every session pod (image: `images/session-workspace`).
It owns the learner's terminals, runs the scenario's scripts, proxies
OpenVSCode, and reports step results to Convex with a session-bound token.

| Endpoint | Purpose |
|---|---|
| `GET /healthz` | Liveness. |
| `GET /ready` | Readiness + summary: `phase` (`starting` → 503, `ready` → 200, `failed` → 500), `failure` (`{component, output}` or `null`), `setup`, `editor`, `preview`, `terminals`. Ready means the agent is listening, the workspace is prepared and, when the scenario has an editor tab, OpenVSCode answers. **Setup is not gated**: it runs in the background and its status is in `setup`; the preview starts once setup has passed and its status is in `preview`. `failed` means setup exited non-zero or the editor/preview process gave up. |
| `GET /state` | Everything `/ready` has plus per-step records and setup output. **Debugging only** — the frontend reads step state from Convex (`steps.listForSession`), not from the pod. |
| `GET /steps/setup` | Status and output of `setup.sh`, which starts automatically once the workspace is prepared. |
| `POST /steps/:i/open` | Runs step *i*'s setup script and returns `{ ran, ok, output }`. Runs once on success; a failed run can be retried. 409 while the same step's setup is already running. |
| `POST /steps/:i/verify` | Runs step *i*'s verify script; returns `{ passed, output, durationMs, timedOut, reported }` after the result has been recorded via `steps.recordStepResult` (`reported` is `false` when Convex could not be reached or rejected the token). 409 while the same step is already being verified. Steps without `verify` return `{ passed: true, noVerify: true }` and are **not** recorded: the frontend advances them on NEXT via `steps.setCurrentStep`. |
| `WS /pty?id=<n>&cols=&rows=` | Terminal *n* (`bash -l` in `workspace.cwd`). Text frames are keystrokes; `"\0" + JSON` is the control channel (`{type:"resize",cols,rows}`). Reconnecting to the same id replays the last 64 KB **as a binary frame**. |
| `/editor/*` (HTTP + WS) | OpenVSCode, started with `--server-base-path /editor` when the scenario has an `editor` tab. |
| `GET /`, `GET /terminal.html` | A minimal xterm.js development page. Served only when the agent starts **without** `SESSION_TOKEN` (standalone, `docker run`); 404 under the dispatcher. |

The Vite preview (react scenarios) listens on `react.previewPort` inside the
pod and is routed by port, not through the agent, so hostile preview content
never shares the agent's origin.

| File | Purpose |
|---|---|
| `agent.mjs` | Entry point; env: `LAB_SCENARIO_DIR`, `AGENT_PORT`, `EDITOR_PORT`, `OPENVSCODE_SERVER_BIN`, `SCRIPT_TIMEOUT_MS`, `AGENT_ALLOWED_WORKSPACE_ROOTS`, `AGENT_LEARNER_ENV_PASSTHROUGH`, optional `CONVEX_URL` / `SESSION_ID` / `SESSION_TOKEN`. |
| `server.mjs` | HTTP + upgrade routing, step state, readiness phases, terminal output backpressure. |
| `websocket.mjs` | Dependency-free RFC 6455 server side with frame/message limits and heartbeat. |
| `pty.mjs` | Terminals: `node-pty` when installed (the image), pipe-backed bash otherwise (tests, dev machines). |
| `scenario.mjs` | Manifest loading (with the `workspace.cwd` root check), workspace preparation, the learner environment allowlist, script execution with the `LAB_*` contract and a process-group timeout. |
| `processes.mjs` | Supervised children (OpenVSCode, Vite) with bounded restarts. |
| `proxy.mjs` | Loopback reverse proxy for HTTP and WebSocket upgrades (hop-by-hop headers stripped, 10 s upstream connect timeout). |
| `reporter.mjs` | Convex HTTP API client for `steps:recordStepResult` using the session token; 8 s per attempt, ~15 s total, no retry on Convex application errors. |

Authentication is not the agent's job: the gateway (ADR 0004) authenticates
learners, and the agent port is only reachable from the gateway.

### Contract for the dispatcher and gateway

What Phase 3 code may rely on:

- **Environment to inject:** `CONVEX_URL`, `SESSION_ID`, `SESSION_TOKEN`
  (plaintext from `sessions.issueAgentToken`, which returns
  `{ token, expiresAt }`; re-issuing replaces the previous token and is safe
  on a dispatcher retry). `LAB_SCENARIO_DIR` defaults to `/scenario`. The
  learner's shells and scripts receive only an allowlist (`PATH`, `HOME`,
  `TERM`, `LANG`, `LC_*`, `SHELL`, `USER`, `LOGNAME`, `TZ`, `COLORTERM`,
  `LAB_*`, plus names listed in `AGENT_LEARNER_ENV_PASSTHROUGH`); everything
  else in the pod environment stays with the agent.
- **Workspace:** `workspace.cwd` must be under `/workspace`, `/home` or
  `/tmp` (`AGENT_ALLOWED_WORKSPACE_ROOTS`); the agent refuses to start
  otherwise. `workspace.user: root` is implemented by the dispatcher's
  `runAsUser: 0`; the agent then uses `HOME=/root`.
- **Readiness:** poll `GET /ready` until `phase` is `ready` (HTTP 200) and
  mark the session running; treat `failed` (HTTP 500, `failure.component` ∈
  `setup | editor | preview`) as a session error. Do not wait for `setup` —
  the shell shows setup status until it passes, and the preview tab appears
  when `preview.status` is `running`.
- **Routing:** the `workspace` endpoint is the agent port (7000): `/pty`,
  `/steps/*`, `/editor/*` with WebSocket upgrade. The `preview` endpoint is
  `preview.port` from `/ready` (`react.previewPort`, 5173) on the pod IP.
  `editor.path` is `/editor/`; `editor.internalPort` is loopback-only inside
  the pod and is **not** routable.
- **Terminals:** ids match `^[a-z0-9-]{1,16}$` (400 otherwise); at most 8
  live terminals per session (429 for a 9th new id; an existing id always
  reattaches). The first message after reattach is the scrollback as a
  **binary** frame, so the frontend must handle binary WebSocket data. The
  server pings every 25 s and closes idle peers (no data for 60 s) with
  1001; frames over 4 MiB, more than 1024 fragments or assembled messages
  over 4 MiB close with 1009; protocol violations with 1002. Output that
  the client cannot drain is queued up to 1 MiB, after which the oldest
  chunks are dropped and `[output dropped]` is written once.
- **Steps:** `POST /steps/:i/verify` returns 409 while that step's verify is
  in flight; `reported` says whether Convex has the result. Steps without
  `verify` are never recorded by the agent.

### Agent token exposure

The learner shares the container's uid with the agent, so the token is
recoverable from `/proc/<agent pid>/environ` (and from the agent's memory)
even though it never enters learner shells. The token authorizes exactly one
thing — `steps.recordStepResult` for its own session — so the worst case is
a learner marking their own steps passed (self-cheating), not access to any
other session or to runner-secret functions. `markExpired` / `markCleaned`
clear the token. A uid split between agent and learner is not planned for
Phase 2; Phase 3 sets `automountServiceAccountToken: false` so nothing more
valuable sits next to it.

```bash
npm run test:runner                                    # includes session-agent unit tests (no node-pty needed)
npm run image:build                                    # learning-lab/session-workspace:dev
npm run agent:integration -- --scenario first-commit   # drives the real image over Docker
LAB_SCENARIO_DIR=$PWD/scenarios/git/first-commit npm run agent:dev   # run the agent on this machine
```

`agent:dev` needs: bash and git on `PATH`; the manifest's `workspace.cwd`
under an allowed root (the repo scenarios use `/workspace` — point
`AGENT_ALLOWED_WORKSPACE_ROOTS` at a copy of the manifest with a local cwd, or
create `/workspace` writable by you); `openvscode-server` on `PATH` or
`OPENVSCODE_SERVER_BIN` for react scenarios (the editor is otherwise reported
`failed`); `node-pty` installed in `runner/session-agent/` for a real TTY
(otherwise a pipe-backed bash without prompt colours or resize).

## What else is here

| File | Purpose |
|---|---|
| `local-runner.mjs` | Legacy local runner. Polls Convex for sessions with `status: requested` and `runner: local`, copies the lab template into `lab-workspaces/<sessionId>`, runs `npm ci`, starts a Vite preview, an OpenVSCode editor, and a per-session workspace/tools server, then marks the session `running`. |
| `workspace-server.mjs` | The per-session tools/check HTTP server the local runner starts (runs the validation command on demand). |
| `session-gateway.mjs` | Stub gateway. Answers health checks and returns `503 gateway-deployment-pending` for everything else; implemented for real in Phase 3 (ADR 0004). |
| `session-runner.ts` | Shared runner lifecycle types (`start` / `check` / `stop` contract). |
| `startup-cancellation.mjs` | Helper for cancelling a session that is stopped while it is still starting. |
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

- Phase 3: `runner/k8s-dispatcher.mjs` and a working `session-gateway.mjs`,
  deployed to kind locally and EKS in `dev` via the Helm chart.

See [`ROADMAP.md`](../ROADMAP.md) and
[ADR 0005](../docs/decisions/0005-kubernetes-execution-model.md).
