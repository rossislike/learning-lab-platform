# Learning Lab Platform Roadmap

Killercoda-style learning platform: terminal-first scenarios with step-by-step
instructions, plus OpenVSCode and a live preview for React scenarios. Runs on
Kubernetes — `kind` locally, EKS in `dev`.

Design: [`docs/2026-10-22/redesign-plan.md`](docs/2026-10-22/redesign-plan.md).
Decisions: [`docs/decisions/`](docs/decisions/) (0005–0007 are the redesign).

## Status board

| Phase | Goal | Status |
|---|---|---|
| 0 | Decide and clear the deck | ✅ Done 2026-10-22 |
| 1 | Scenario manifest v2 + content | ✅ Done 2026-10-24 |
| 2 | Session workspace image + agent | ✅ Done 2026-10-25 |
| 3 | Dispatcher + gateway on kind | 🔧 Code complete 2026-10-25 — `cluster:up` + `gateway:smoke` run pending on your Mac |
| 4 | Frontend rewrite (Killercoda shell) | 🔜 **Next** |
| 5 | `dev` environment on EKS | ⏳ Not started (after 3) |
| 6 | CI, TTL reaper, alarms | ⏳ Not started |

Legend: ✅ done · 🔧 in progress · 🔜 next · ⏳ not started · ❌ dropped

**You are here:** Phase 3 is code complete; run `npm run cluster:up && npm run gateway:smoke` on a machine with Docker/kind/helm to close it. Then Phase 4: the Killercoda-style frontend against the gateway (`workspaceAccess.issueBootstrap` → `POST /__llp/bootstrap` on each endpoint host → WebSocket `/pty`, iframes for `/editor` and the preview host).

---

## Phase 0 — Decide and clear the deck ✅

- [x] ADR 0005: Kubernetes execution model (kind local, EKS Auto Mode dev); supersedes ADR 0001.
- [x] ADR 0006: Scenario manifest v2 and step model.
- [x] ADR 0007: Two environments, `local` and `dev`.
- [x] Remove ECS/Fargate runners, hosted images, dispatcher runtime, and their tests.
- [x] Remove `infra/aws/environments/{staging,production}`, `modules/hosted-runner`, `egress-proxy`, and the disposable `terraform` validation root. Keep `bootstrap/` and `account-security/`.
- [x] Remove hosted-AWS validation/teardown/isolation scripts, docs, and the image-delivery workflow.
- [x] Convex: `runner` is `local | kubernetes`; artifact-approval `environment` is `dev` only; `HOSTED_ENVIRONMENT` fails closed on anything else.
- [x] `config/hosted-environments.json` and `config/aws-terraform-backends.json` describe `local` and `dev` only; production Clerk/Convex recorded as parked.
- [x] `package.json` scripts and `.env.example` trimmed to what still exists.
- [x] Rewrite this roadmap; trim the README and `infra/aws/README.md`.

## Phase 1 — Scenario manifest v2 and content ✅

Exit: eleven v2 scenarios import cleanly and the terminal ones pass the smoke test.

- [x] Author `scenarios/git/first-commit` by hand as the reference scenario (intro, 3 steps, finish, verify + solve scripts).
- [x] `scenarios/manifest.schema.json` and `scenarios/area.schema.json`; `scripts/json-schema.mjs` validates against them (no new dependency).
- [x] Rewrite `scripts/import-scenarios.mjs`: validate, inline markdown into `convex/scenarioSeedData.ts`, build digest-named bundles under `build/scenarios/` (git-ignored; solutions and solve scripts excluded, `steps[].solve` stripped from the bundled manifest). `scripts/scenario-catalog.mjs` is the shared loader.
- [x] Convex: `areas` table; v2 fields on `labs` (`area`, `kind`, `steps`, `intro`, `finish`, `workspace`, `react`, `tabs`); `sessions.currentStep`; `sessionSteps` table; `completedSteps`/`totalSteps` on progress records; `steps.setCurrentStep` / `steps.recordStepResult` / `steps.listForSession`; navigation rules in `stepPolicy.ts` with tests. Hosted runtime contract (`scenarioArtifactPolicy.ts`) now carries the v2 shape.
- [x] Convert the four React labs to `scenarios/react/*` (2–4 steps each; vitest is the final verify; `solution/src/` + solve script). Delete `lab-definitions/`.
- [x] Author `linux/filesystem-basics` and `node/cli-tool`; one zero-step playground per area (react playground = minimal Vite app).
- [x] Rewrite `scripts/smoke-test-scenarios.mjs` for v2: setup → per step verify-fails → solve → verify-passes, in Docker (`node:22-bookworm` until the Phase 2 image) or `--local`.
- [x] Terminal scenarios proven: `first-commit`, `filesystem-basics`, `cli-tool` (9/9 steps). React scripts proven with a dependency-free stand-in workspace.
- [x] React scenarios verified on a machine with npm access (2026-10-24): `welcome-message`, `button-label`, `empty-state`, `product-dashboard` fail→solve→pass; `react-playground` setup ok.

Deviations from the plan, on purpose:

- The `labs` table keeps its name until the Phase 4 frontend rewrite; v1-only fields became optional instead of being dropped, so the legacy local Docker runner (deleted in Phase 3) could keep running React scenarios until the dispatcher landed (`templatePath`, `validationCommand`, `previewCommand` were derived from the v2 `react` block). Until Phase 3, `sessions.request` rejected terminal scenarios on that runner.
- Playground slugs are `<area>-playground` (slugs are global) in a `playground/` directory.
- The hosted runtime contract (`scenarioArtifactApprovals.runtime`, `sessions.hostedScenario`) changed shape to the v2 fields; there is no migration. Any Convex deployment holding old approval/hostedScenario rows must have them cleared before the schema push (local dev deployments: `npx convex run` a one-off, or wipe the tables from the dashboard).

## Phase 2 — Session workspace image and agent ✅

Exit: `docker run` of the image with a mounted scenario serves a working terminal to a 30-line xterm.js page and verifies a step.

- [x] `images/session-workspace/Dockerfile`: `node:22-bookworm-slim` (Debian, not Ubuntu — same Node base as the scenarios), git, OpenVSCode 1.93.1 (`OPENVSCODE_VERSION` build arg), non-root `learner` (uid 1001), `tini`. `build.sh` builds native + `--load` or `--push` multi-arch (arm64 + amd64).
- [x] `runner/session-agent/`: HTTP + WS on `:7000` — `/healthz`, `/ready` (`phase: starting | ready | failed`; ready = terminal usable, setup runs in the background), `GET /steps/setup`, `POST /steps/:i/open`, `POST /steps/:i/verify`, `WS /pty?id=` (reattach replays scrollback; `\0`+JSON control channel for resize; heartbeat, frame limits, output backpressure), `/editor/*` proxy (OpenVSCode with `--server-base-path /editor`). Scripts run per `docs/scenario-authoring.md` (`bash`, cwd, `LAB_*`, process-group timeout); react bundles copy `workspace/` first. Dependency-free RFC 6455 server; `node-pty` only in the image, pipe-backed fallback elsewhere.
- [x] Preview routed by port (5173), not through the agent, so hostile preview content never shares the agent origin (ADR 0003 amended).
- [x] Session-bound agent token: `sessions.issueAgentToken` (runner secret) returns the plaintext once and stores only its SHA-256 + expiry (`convex/sha256.ts`, pure TS); `steps.recordStepResult` requires `sessionToken` (no runner-secret path); `markExpired`/`markCleaned` clear the token. Learner shells/scripts get an environment **allowlist** (`PATH`, `HOME`, `TERM`, `LANG`, `LC_*`, `SHELL`, `USER`, `LOGNAME`, `TZ`, `COLORTERM`, `LAB_*`, `AGENT_LEARNER_ENV_PASSTHROUGH`). Known limit: the learner shares the agent's uid, so the token is recoverable from `/proc`; it only authorizes recording the learner's own step results (self-cheating), see `runner/README.md` "Agent token exposure". No uid split in this phase.
- [x] Unit tests (`runner/session-agent/*.test.mjs`): WebSocket handshake/echo/large frames/close codes/protocol violations/ping-idle, full agent flow against `git/first-commit` (setup → verify fails → terminal does the work → verify passes → results reported → scrollback replay), readiness phases, open/verify races, terminal cap, malformed request targets, react workspace copy, script path contract + timeout, env allowlist, cwd roots, proxy forward/502/upgrade relay, reporter retries/timeouts.
- [x] `scripts/agent-integration-test.mjs` (`npm run agent:integration`): drives the built image over Docker — readiness, terminal user/cwd/tty, every verifiable step fails→solve→passes, editor proxy and preview for react scenarios. The smoke test now prefers `learning-lab/session-workspace:dev` when it exists.
- [x] Image built and the Docker integration test passes for `first-commit` (3/3 steps, TTY, learner user) and `welcome-message` (verify, editor proxy, preview) — 2026-10-25. Two image fixes came out of it: `/opt/agent` must be world-readable, and OpenVSCode serves the workbench at exactly `/editor` and needs its data directories pre-created.
- [x] `runner/session-agent/package-lock.json` committed (2026-10-25); the image build uses `npm ci`.

Deviations: the legacy entrypoint was not salvaged literally — process supervision and readiness were rewritten in `processes.mjs`/`server.mjs` around the step model. The dispatcher (Phase 3) reads pod readiness from `GET /ready` and records endpoints in Convex; the agent itself only reports step results.

## Phase 3 — Dispatcher and gateway on Kubernetes 🔧

Exit: `npm run dev:all` brings up Convex, Vite, kind, dispatcher, gateway; a session pod starts from the UI and the old Docker runner is deleted.

- [x] `runner/dispatcher/` — dependency-free (Kubernetes REST + Convex HTTP API; no `@kubernetes/client-node`): `listForDispatcher` → `markStarting` → `issueAgentToken` → pod (`pod-spec.mjs`: no SA token, non-root unless `workspace.user: root`, drop ALL caps, limits, `activeDeadlineSeconds` TTL backstop, hostPath bundle at `/scenario`) → kubelet Ready (readiness probe = agent `/ready`) → `markRunning` with `ws-`/`pv-` URLs; startup timeout and failed pods → `markErrored`; expiry, cleanup, orphan reaping; `runners:acquireLease` for replica safety. Tests with in-memory Convex/Kubernetes fakes.
- [x] `runner/gateway/` — ADR 0004: `ws-<routeId>`/`pv-<routeId>` hosts, `POST /__llp/bootstrap` (exact app `Origin`, JSON, size and rate limits) → host-only cookie `grantId.verifier` (`__Host-llp`, or `llp` on plain http), `checkGrant`/`resolveRoute` cached ≤ 5 s, credential stripping both ways, `frame-ancestors`, WebSocket `Origin` rules, `/__llp/logout`, dev page. End-to-end test through the real agent.
- [x] Convex: runner is `kubernetes` only; `HOSTED_ENVIRONMENT` `local` (bundles from the repo, no approvals) or `dev`; `sessions.request` allows the auth-disabled local mode and enforces `MAX_ACTIVE_SESSIONS`; `routeId`/`podName`/`podIp`/`agentPort` on sessions; `bootstrapCodes`, `accessGrants`, `leases` tables; `workspaceAccess.*`; `labs.sourceDir` from the importer.
- [x] `deploy/helm/learning-lab/`: `sessions` namespace (PSA level configurable; `privileged` locally because of hostPath), `ResourceQuota`, gateway-only ingress + internet-only egress NetworkPolicies, dispatcher ServiceAccount/Role/RoleBinding, gateway NodePort Service, platform Secret from values.
- [x] `deploy/kind/cluster.yaml.tpl` (scenarios mount, 30080 → 127.0.0.1:8080) rendered by `scripts/cluster.mjs` (`cluster:up|deploy|status|logs|down`); `npm run dev:all` runs `cluster up` as an idempotent one-shot step; `images/platform/Dockerfile`.
- [x] `scripts/gateway-smoke.mjs` (`npm run gateway:smoke`): request → pod → running → bootstrap → gateway `/ready` + terminal + verify (result reported to Convex) → preview → stop → cleaned.
- [x] Deleted the legacy local runner (`local-runner.mjs`, `workspace-server.mjs`, `session-gateway.mjs` stub, `session-runner.ts`, `startup-cancellation.mjs`, `learner-process-env.mjs`) and the `local` runner enum; the dashboard requests `kubernetes` sessions.
- [x] Review fixes (2026-10-25): `runners.heartbeat` takes `runnerSecret` and a static contract test (`runner/shared/convex-contract.test.mjs`) checks every dispatcher/gateway call against `convex/`; routing metadata is written before the pod exists and back-filled from pod labels; running sessions whose pod is gone are errored; stop/expire/error revoke access grants; `podIp` validated (no loopback/link-local) on both sides; `workspace.cwd` restricted to `/workspace`/`/home/<user>`; gateway: per-route + global bootstrap limits, `Origin` on logout and state-changing requests, app upstream only under the app host with `Host` kept (Vite `allowedHosts`), grant-bound socket teardown with a 5 s re-validation sweep, caches bounded by expiry, dev page refused with secure cookies and `?code=` limited to direct navigations, bare `/__llp/health` on endpoint hosts, Convex error messages sanitized; `cluster.mjs` recovers pending Helm releases and uses `--set-string`; dashboard no longer probes or frames gateway URLs (Phase 4 shell does the bootstrap).
- [ ] **Run on your Mac (needs Docker, kind, kubectl, helm, and a Convex dev deployment with `RUNNER_SHARED_SECRET` + `ALLOW_UNAUTHENTICATED_LOCAL_MODE=true`):** `npx convex dev` (also confirms the `./sha256.ts` import bundles), then `npm run cluster:up && npm run gateway:smoke && npm run gateway:smoke -- --scenario welcome-message`.
- [ ] If an existing Convex dev deployment holds sessions with `runner: "local"` or old `hostedScenario` shapes, clear the `sessions`, `progressRecords`, `sessionEvents`, `sessionSteps`, `runnerHeartbeats` tables before the schema push.

Deviations: no headless Service per session (the gateway proxies to the pod IP, which is stable for the pod's life); readiness comes from the kubelet condition rather than the dispatcher polling the agent; NetworkPolicies are declared but kind's default CNI does not enforce them (EKS does).

## Phase 4 — Frontend rewrite 🔜

Exit: all Phase 1 scenarios run end-to-end on local/kind from the new UI.

- [ ] New `src/` with React Router; delete `App.tsx`. Switch to Convex `useQuery` subscriptions.
- [ ] `/` Areas grid with search; Playgrounds and Examples tiles first.
- [ ] `/:area` scenario cards with completion check marks from progress records.
- [ ] Session access: after `sessions.request`, poll until `running`, call `workspaceAccess.issueBootstrap`, `POST` each code to `<workspaceUrl>/__llp/bootstrap` and `<previewUrl>/__llp/bootstrap` with `credentials: "include"`, then open `/pty` (WebSocket, binary frames) and iframe `/editor?folder=…` and the preview origin. Locally the app must be served from the same site as the gateway (`app.lab.localhost:8080` via `GATEWAY_APP_UPSTREAM`) so the `SameSite=Lax` cookie is sent.
- [ ] `/:area/:slug` scenario shell: left `InstructionPane` (title, step dots, markdown with `<details>` and run-in-terminal code blocks, `START`/`BACK`/`NEXT`, verify feedback), right `WorkspacePane` (tab strip `Terminal | Editor | Preview | +`, xterm.js over gateway WS, iframes for editor/preview, TTL countdown, stop).
- [ ] Session states: initialising line in the terminal pane; errored/expired modal with retry.
- [ ] `/admin`: sessions table, runner heartbeat, import scenarios (operator only).
- [ ] Visual pass to match `docs/2026-10-22/*.png`: dark terminal pane, light instruction pane.

## Phase 5 — `dev` environment on EKS ⏳

Exit: a React and a terminal scenario run end-to-end from a phone browser against `app.dev.<domain>`.

- [ ] `infra/aws/modules/eks-platform`: VPC (2 AZ, private pod subnets, NAT), EKS Auto Mode, ECR repos, ACM wildcard + Route 53 (`app.dev.<domain>`, `*.dev.<domain>`), scenario-bundle S3 bucket (create-only), IRSA for dispatcher, CloudWatch log group, S3 + CloudFront + OAC for the frontend.
- [ ] `infra/aws/environments/dev` root using the existing backend; deletion protection off.
- [ ] Helm values for dev: ALB Ingress, wildcard host, image digests.
- [ ] Clear legacy `staging`/`aws-ecs-fargate` rows from `scenarioArtifactApprovals`, `sessions`, `runnerHeartbeats` on `upbeat-crab-254` (or run a one-off internalMutation) before the first schema push. This includes every pre-Phase-1 `scenarioArtifactApprovals.runtime` and `sessions.hostedScenario` value: their shape changed to the manifest v2 contract and the old rows no longer validate.
- [ ] Convex deploy to `upbeat-crab-254`; Clerk dev instance allowed origins.
- [ ] `npm run infra:dev:plan|apply`, `npm run deploy:dev` (build → push ECR → helm upgrade → convex deploy → S3 sync + CloudFront invalidation).

## Phase 6 — CI, TTL reaper, alarms ⏳

- [ ] GitHub Actions: lint + tests + scenario smoke on kind for PRs; on `main`: build/push images by digest, publish bundles, convex deploy, helm upgrade dev, frontend sync. Reuse `modules/github-image-delivery` OIDC.
  - [ ] Rework `modules/github-image-delivery` for a single `dev` environment (drop staging→production promotion sources and the environment enum).
- [ ] In-cluster CronJob TTL reaper (replaces the ECS Lambda).
- [ ] Alarms: gateway 5xx, dispatcher heartbeat stale, pod launch failures, daily cost budget.

## Later ⏳

- [ ] Kubernetes-API scenarios via `vcluster` per session (CKA/CKAD-style areas).
- [ ] Organizations/teams, enrollment, role-based access.
- [ ] Author-facing publishing workflow.
- [ ] Quotas and abuse prevention before any public access.

## Dropped from the previous roadmap ❌

ECS/Fargate dispatcher and standalone tasks; staging → production promotion;
image signing/SBOM gates; production kill switch and canary cohort; the
ECS-specific metadata, credential, and network boundary validations. Revisit
individual items if the platform goes public.
