# Runner

`runner/` holds the three platform programs of the Kubernetes design
(ADR 0005): the session agent (`session-agent/`, inside every session pod),
the dispatcher (`dispatcher/`, Convex sessions → pods) and the gateway
(`gateway/`, the only ingress to pods), plus `shared/` (Convex HTTP client,
reverse proxy, pod-IP rules). Phase 2 and Phase 3 are code complete; the
image build, the Docker integration run and the kind cluster run are
pending. The legacy local Docker runner is gone.

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
| `/editor`, `/editor/*` (HTTP + WS) | OpenVSCode, started with `--server-base-path /editor` when the scenario has an `editor` tab. The workbench is at exactly `/editor` (the agent also accepts `/editor/`); open `editor.path` from `/ready`, which carries `?folder=<cwd>`. |
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
  `editor.path` is `/editor?folder=<cwd>`; `editor.internalPort` is loopback-only inside
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

## Dispatcher (`dispatcher/`)

Turns Convex sessions into pods (ADR 0005). Dependency-free: it talks to the
Kubernetes REST API directly (`k8s.mjs`, in-cluster service account or
`kubectl config view --raw` on a developer machine) and to Convex over its
HTTP API (`shared/convex-http.mjs`).

Each tick, idempotent and safe to repeat after a crash:

1. `runners:heartbeat`, then `runners:acquireLease` — only the lease holder
   acts, so replicas never double-launch.
2. `sessions:listForDispatcher` — one round trip with everything attached.
3. `requested` → `sessions:markStarting` → `sessions:issueAgentToken` →
   `sessions:updateRunnerMetadata` (routeId, podName, ports — written
   **before** the pod exists so a crash never leaves an unroutable pod) →
   create the pod (`pod-spec.mjs`). `starting` → wait for the kubelet Ready
   condition (the readiness probe is the agent's `/ready`) → record `podIp`
   (re-sending the routing metadata from the pod labels if Convex lost it) →
   `sessions:markRunning` with the `ws-`/`pv-` URLs. A pod that fails, or
   does not become ready within `DISPATCHER_STARTUP_TIMEOUT_MS`, is deleted
   and the session errored.
4. `expired` → `sessions:markExpired`; `cleanup` → delete pod →
   `sessions:markCleaned`; session pods Convex no longer knows as active are
   deleted after a 60 s grace; a `running`/`checking`/`passed`/`failed`
   session whose pod is gone or finished (TTL deadline, eviction, OOM) is
   errored.

Every Convex function these programs call must take `runnerSecret`;
`shared/convex-contract.test.mjs` checks that statically against `convex/`.

Pod shape: `restartPolicy: Never`, no service-account token, non-root
`learner` (uid 1001) unless the manifest says `workspace.user: root`,
`capabilities: drop ALL`, seccomp RuntimeDefault, CPU/memory/ephemeral
limits, `activeDeadlineSeconds = ttl + 10 min` as a kubelet-enforced TTL
backstop. The bundle is mounted read-only at `/scenario` from the node's
`/scenarios/<sourceDir>` (`BUNDLE_MODE=hostPath`, local); `s3` arrives in
Phase 5. Env injected: `CONVEX_URL`, `SESSION_ID`, `SESSION_TOKEN`.
`workspace.cwd` is the workspace volume's mount path and must be under
`/workspace` or `/home/<user>` (the dispatcher refuses anything else).

Known exposures, accepted for local and dev:

- `SESSION_TOKEN` is a plain pod env var, readable by anyone with `pods/get`
  in the `sessions` namespace (the dispatcher's own Role, cluster admins).
  It authorizes only `steps.recordStepResult` for that session (see "Agent
  token exposure" above); a Secret-backed env var would be readable by the
  same principals.
- `BUNDLE_MODE=hostPath` mounts `scenarios/<sourceDir>` **including its
  `solution/` directory** into the pod (read-only, local only). Learners on
  a local kind cluster are the developer; `dev` uses S3 bundles (Phase 5),
  where the published bundle excludes `solution/`.

```bash
npm run dispatcher:once     # one tick from this machine against the current kubeconfig context
```

`dispatcher:once` needs the lease: scale the in-cluster dispatcher to 0
first (`kubectl -n learning-lab scale deploy/llp-dispatcher --replicas=0`),
otherwise the local tick logs `skipped: lease` and does nothing; scale it
back to 1 afterwards. The kubeconfig mode (`k8s.mjs`) supports
client-certificate and static-token users only (kind); exec/auth-provider
credential plugins (EKS, GKE) are refused — run the dispatcher in-cluster
there. In-cluster, the projected service-account token is re-read once on a
401 (token rotation).

## Gateway (`gateway/`)

The only way into a session pod (ADR 0003/0004). Hosts
`ws-<routeId>.<suffix>` → pod:7000 (terminals, steps, `/editor`) and
`pv-<routeId>.<suffix>` → pod:previewPort. Reserved `/__llp/*` paths are
never proxied:

| Path | Purpose |
|---|---|
| `GET /__llp/health` | Liveness (any host); request/denial stats only under the app host. |
| `POST /__llp/bootstrap` `{code}` | Consumes a one-time code from `workspaceAccess:issueBootstrap` (exact `Origin` = `GATEWAY_APP_ORIGIN`, checked before anything is counted; JSON only, ≤ 4 KB; 20 failures/min per route and 200/min overall) and sets the host-only cookie `<grantId>.<verifier>` (`__Host-llp`, or `llp` when `GATEWAY_SECURE_COOKIES=false`). A rejected code is recorded as a session event by reason; the response is always a bare 401. |
| `POST /__llp/logout` | Revokes the cookie's grant (exact `Origin` = app origin) and destroys that grant's open connections. |
| `GET /__llp/dev[?code=]` | Dev terminal page on workspace hosts when `GATEWAY_DEV_PAGE=true` (refused at startup unless `GATEWAY_SECURE_COOKIES=false`); `?code=` consumes a code first and only for a direct navigation (`Sec-Fetch-Site` absent, `none` or `same-site`). |

Everything else: cookie → `workspaceAccess:checkGrant` (cached ≤ 5 s and
never past the grant's expiry; 401/403) → `workspaceAccess:resolveRoute`
(cached the same way; 503 while the session is not running; loopback and
link-local pod IPs are never proxied to) → proxy with the platform cookie,
`Authorization`, and forwarding headers stripped, `X-Forwarded-Host/Proto`
added, pod `Set-Cookie` headers with a `Domain` or a platform name dropped,
and `Content-Security-Policy: frame-ancestors 'self' <appOrigin>`. Requests
with a method other than GET/HEAD/OPTIONS, and every WebSocket upgrade, must
carry an allowed `Origin` (workspace: app origin or own host; preview: own
host); a request with no `Origin` passes only when it has no
`Sec-Fetch-Site` either (a non-browser client, for which the grant is the
credential). Proxied connections are tracked per grant: logout destroys
them, and a 5 s sweep re-validates every grant with live connections and
destroys those no longer valid (stop/expire/error revoke all grants in
Convex). Requests whose `Host` is exactly the app origin's host go to
`GATEWAY_APP_UPSTREAM` when set (the Vite dev server locally, with the
original `Host` kept — Vite 7 only accepts hosts listed in
`server.allowedHosts`); every other non-endpoint host is 404.

## Local cluster

```bash
npm run cluster:up        # kind cluster "learning-lab" + images + Helm chart (idempotent)
npm run cluster:deploy    # rebuild + reload images, upgrade the chart
npm run cluster:status    # pods + recent logs
npm run cluster:logs
npm run cluster:down
npm run gateway:smoke     # end-to-end: request → pod → gateway → terminal → verify → stop
```

`deploy/kind/cluster.yaml.tpl` mounts `scenarios/` into the node at
`/scenarios` and maps node port 30080 → `127.0.0.1:8080`.
`deploy/helm/learning-lab/` installs the dispatcher (ServiceAccount + Role on
pods in `sessions`), the gateway (NodePort), the `sessions` namespace with a
`ResourceQuota`, and NetworkPolicies (gateway-only ingress, internet-only
egress — enforced on EKS, not by kind's default CNI). `images/platform` holds
both programs; the command is set per Deployment.

Browsers resolve `*.localhost` to loopback (Chrome, Firefox), so
`http://ws-<routeId>.lab.localhost:8080` works without DNS; scripts set the
`Host` header by hand. Open the dashboard at `http://app.lab.localhost:8080`
(through the gateway) so its origin is the one workspace endpoints trust.

Troubleshooting:

- `kind load docker-image` fails: `docker save <image> -o build/<name>.tar`
  then `kind load image-archive build/<name>.tar --name learning-lab`.
- An interrupted `helm upgrade` leaves the release `pending-*`;
  `cluster:deploy` rolls back (revision > 1) or uninstalls it first.
- `dispatcher:once` reports `skipped: "lease"`: the in-cluster dispatcher
  holds the lease — scale it to 0 (see above).
- Dashboard under `app.lab.localhost` shows Vite's "host is not allowed":
  check `server.allowedHosts` in `vite.config.ts`.

See [`ROADMAP.md`](../ROADMAP.md) and
[ADR 0005](../docs/decisions/0005-kubernetes-execution-model.md).
