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
| 3 | Dispatcher + gateway on kind | ✅ Done 2026-10-27 |
| 4 | Frontend rewrite (Killercoda shell) | 🔜 **Next** |
| 5 | `dev` environment on EKS | ⏳ Not started (after 3) |
| 6 | CI, TTL reaper, alarms | ⏳ Not started |

Legend: ✅ done · 🔧 in progress · 🔜 next · ⏳ not started · ❌ dropped

**You are here:** Phases 0–5 are complete: `dev` runs on EKS Auto Mode at `https://app.dev.learning-lab-platform.rumothy.com` with terminal and React scenarios verified end to end, including from a phone. Next: Phase 6 — CI (build/push by digest, deploy on `main`), the in-cluster TTL reaper, alarms — plus the deferred security items (operator-gated `/admin` and `seedScenarios`, owner-indexed `listMine` queries).

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

## Phase 3 — Dispatcher and gateway on Kubernetes ✅

Exit: `npm run dev:all` brings up Convex, Vite, kind, dispatcher, gateway; a session pod starts from the UI and the old Docker runner is deleted.

- [x] `runner/dispatcher/` — dependency-free (Kubernetes REST + Convex HTTP API; no `@kubernetes/client-node`): `listForDispatcher` → `markStarting` → `issueAgentToken` → pod (`pod-spec.mjs`: no SA token, non-root unless `workspace.user: root`, drop ALL caps, limits, `activeDeadlineSeconds` TTL backstop, hostPath bundle at `/scenario`) → kubelet Ready (readiness probe = agent `/ready`) → `markRunning` with `ws-`/`pv-` URLs; startup timeout and failed pods → `markErrored`; expiry, cleanup, orphan reaping; `runners:acquireLease` for replica safety. Tests with in-memory Convex/Kubernetes fakes.
- [x] `runner/gateway/` — ADR 0004: `ws-<routeId>`/`pv-<routeId>` hosts, `POST /__llp/bootstrap` (exact app `Origin`, JSON, size and rate limits) → host-only cookie `grantId.verifier` (`__Host-llp`, or `llp` on plain http), `checkGrant`/`resolveRoute` cached ≤ 5 s, credential stripping both ways, `frame-ancestors`, WebSocket `Origin` rules, `/__llp/logout`, dev page. End-to-end test through the real agent.
- [x] Convex: runner is `kubernetes` only; `HOSTED_ENVIRONMENT` `local` (bundles from the repo, no approvals) or `dev`; `sessions.request` allows the auth-disabled local mode and enforces `MAX_ACTIVE_SESSIONS`; `routeId`/`podName`/`podIp`/`agentPort` on sessions; `bootstrapCodes`, `accessGrants`, `leases` tables; `workspaceAccess.*`; `labs.sourceDir` from the importer.
- [x] `deploy/helm/learning-lab/`: `sessions` namespace (PSA level configurable; `privileged` locally because of hostPath), `ResourceQuota`, gateway-only ingress + internet-only egress NetworkPolicies, dispatcher ServiceAccount/Role/RoleBinding, gateway NodePort Service, platform Secret from values.
- [x] `deploy/kind/cluster.yaml.tpl` (scenarios mount, 30080 → 127.0.0.1:8080) rendered by `scripts/cluster.mjs` (`cluster:up|deploy|status|logs|down`); `npm run dev:all` runs `cluster up` as an idempotent one-shot step; `images/platform/Dockerfile`.
- [x] `scripts/gateway-smoke.mjs` (`npm run gateway:smoke`): request → pod → running → bootstrap → gateway `/ready` + terminal + verify (result reported to Convex) → preview → stop → cleaned.
- [x] Deleted the legacy local runner (`local-runner.mjs`, `workspace-server.mjs`, `session-gateway.mjs` stub, `session-runner.ts`, `startup-cancellation.mjs`, `learner-process-env.mjs`) and the `local` runner enum; the dashboard requests `kubernetes` sessions.
- [x] Review fixes (2026-10-25): `runners.heartbeat` takes `runnerSecret` and a static contract test (`runner/shared/convex-contract.test.mjs`) checks every dispatcher/gateway call against `convex/`; routing metadata is written before the pod exists and back-filled from pod labels; running sessions whose pod is gone are errored; stop/expire/error revoke access grants; `podIp` validated (no loopback/link-local) on both sides; `workspace.cwd` restricted to `/workspace`/`/home/<user>`; gateway: per-route + global bootstrap limits, `Origin` on logout and state-changing requests, app upstream only under the app host with `Host` kept (Vite `allowedHosts`), grant-bound socket teardown with a 5 s re-validation sweep, caches bounded by expiry, dev page refused with secure cookies and `?code=` limited to direct navigations, bare `/__llp/health` on endpoint hosts, Convex error messages sanitized; `cluster.mjs` recovers pending Helm releases and uses `--set-string`; dashboard no longer probes or frames gateway URLs (Phase 4 shell does the bootstrap).
- [x] Verified on a Mac 2026-10-27: `npx convex dev` pushed the schema (the `./sha256.ts` import bundles), `npm run cluster:up` built and installed everything on kind, and `npm run gateway:smoke` passed for `first-commit` (request → pod → running → bootstrap → gateway terminal → verify reported → stop → cleaned).
- [x] Legacy `runner: "local"` rows had to be cleared before the schema push (done via the Convex dashboard); `labs.seedScenarios` re-seeded the v2 catalog.

Deviations: no headless Service per session (the gateway proxies to the pod IP, which is stable for the pod's life); readiness comes from the kubelet condition rather than the dispatcher polling the agent; NetworkPolicies are declared but kind's default CNI does not enforce them (EKS does).

## Phase 4 — Frontend rewrite ✅

Exit: all Phase 1 scenarios run end-to-end on local/kind from the new UI.

- [x] New `src/` with React Router (`main.tsx` → `Layout` → `/`, `/:area`, `/:area/:slug`, `/admin`); `App.tsx`/`styles.css` deleted. All reads are Convex `useQuery` subscriptions, no polling of Convex.
- [x] `/` Areas grid with search (kept in `?q=`); a Playgrounds tile first, which filters the catalog to the playground scenarios (`AreasPage`).
- [x] `/:area` scenario cards with completion check marks from `progress.list` (`AreaPage`).
- [x] Session access (`lib/useScenarioSession.ts`, `lib/gateway.ts`): opening a scenario calls `sessions.request` once; when the session is `running` the shell probes `<workspaceUrl>/ready`, and on 401/403 calls `workspaceAccess.issueBootstrap` and `POST`s each code to `<workspaceUrl>/__llp/bootstrap` and `<previewUrl>/__llp/bootstrap` with `credentials: "include"`; then it follows `/ready` until setup and preview have settled. The app is served through the gateway at `app.lab.localhost:8080` (`GATEWAY_APP_UPSTREAM`), so the app and the endpoint hosts are same-site and the `SameSite=Lax` cookie is sent; the gateway answers credentialed CORS for the app origin on the endpoint hosts (`c28f9ba`).
- [x] `/:area/:slug` scenario shell (`ScenarioPage`): left `InstructionPane` (title, step dots, markdown with `<details>` and run-in-terminal code blocks, `START`/`BACK`/`NEXT`/`FINISH`, verify output under the step), right `WorkspacePane` (tab strip `Editor | Preview | Terminal N | +` from `manifest.tabs`, xterm.js over the gateway WebSocket with reconnect/resize/scrollback replay, iframes for `/editor?folder=…` and the preview origin gated on the agent reporting them running, TTL countdown, `Stop`).
- [x] Session states (`lib/sessionState.ts`, pure and unit-tested): the page follows the newest session for the scenario whatever its status; it requests one automatically only on the first open when the learner has no session for that scenario at all (once per open), never after `Stop`. Status line in the workspace bar (requesting → starting → connecting → running setup → ready/preview starting); banners for a session active in another scenario (with `Stop that session`; the request follows once it is stopped), request errors (`Try again`), stopped/errored/expired sessions with the reason (`Start a new session`), workspace access failures (`Reconnect`), and failed step moves/setup/stop.
- [x] `/admin`: seed scenarios, dispatcher heartbeat (`runners.latest`), sessions table with `Stop`.
- [x] Review fixes (2026-10-27): scenario markdown is sanitized after `rehype-raw` (`rehype-sanitize`, GitHub schema; `<details>`, task lists and `language-*` survive) and only `bash|sh|shell|zsh` fences are runnable; `/ready` bodies are shape-checked (`parseReadyBody`) so a gateway `503 {"error"}` cannot crash the page, and an `ErrorBoundary` wraps the routes; the terminal keeps per-connection state (no stale socket handlers, `term.reset()` before the scrollback replay, input as binary frames so `\0` is never read as a control frame, gives up after repeated failures and asks the page to re-check access); access probes both the workspace and the preview host and bootstraps each independently, cannot stick in "connecting", re-bootstraps on 401/403 from verify, step setup, readiness or a failed terminal; `reported: false` from verify is shown to the learner; the scenario shell is keyed by route; the preview iframe is sandboxed (the editor cannot be: VS Code web does not start in a sandboxed frame), both with `referrerPolicy="no-referrer"`; with configured auth the routes wait for `useConvexAuth().isAuthenticated`. Tests: `npm run test:web` (`src/lib/*.test.mjs`: session state, `/ready` classification, gateway client, markdown sanitizing). Checked with `tsc -b`, `eslint`, the unit tests, and re-verified in a browser on kind (terminal, Stop → ended banner → new session, editor + preview tabs).
- [x] Visual pass after `docs/2026-10-22/*.png`: black top bar, light catalog/instructions, dark workspace (`src/app.css`).
- [x] Verified in a browser on kind 2026-10-27: terminal scenario (`git/first-commit`) and a React scenario (editor + preview tabs).

Deviations: the Phase 0 product-surface gates (`VITE_SESSION_ACCESS_MODE`, `VITE_COST_CONTROLS_MODE`) are not wired into the new shell; they return with the hosted `dev` surface in Phase 5 (`docs/product-readiness.md` still describes the contract). Clerk is wired for `VITE_AUTH_MODE=configured` (`@clerk/react` 6: `useUser` gate, `SignInButton`, `UserButton`) but only exercised with auth disabled locally. New dependencies: `react-router@7`, `@xterm/xterm`, `@xterm/addon-fit`, `react-markdown`, `remark-gfm`, `rehype-raw`, `rehype-sanitize`. `lucide-react` and `react-resizable-panels` are no longer imported anywhere and can be dropped from `package.json` with the next `npm install`.

Backend gaps found in the Phase 4 review, deferred to Phase 5 (Clerk roles, hosted surface): `/admin` is not operator-gated in the UI, and `labs.seedScenarios` has no auth check at all (any caller can re-seed the catalog); `sessions.list` and `progress.list` read the latest 100/200 rows across all owners and filter by owner afterwards, so a learner's own rows can fall out of the window once there are several users — a `listMine` on the `by_session_owner` index (and the progress equivalent) is needed before multi-user `dev`. The gateway sets `frame-ancestors` on the endpoint hosts but not on the app host it proxies (`GATEWAY_APP_UPSTREAM`), so the app itself can be framed; the hosted app (CloudFront) needs `frame-ancestors 'none'` in Phase 5.

## Phase 5 — `dev` environment on EKS ✅

Exit: a React and a terminal scenario run end-to-end from a phone browser against `app.dev.learning-lab-platform.rumothy.com`.

- [x] `infra/aws/modules/eks-platform`: VPC (2 AZ, private pod subnets, NAT per AZ, S3 gateway endpoint), EKS Auto Mode (`general-purpose` + `system` pools, API auth mode, control-plane logs to CloudWatch), ECR repos (`learning-lab/platform`, `learning-lab/session-workspace`), ACM wildcard `*.dev.<domain>` in `us-east-2` (ALB) and `us-east-1` (CloudFront) validated in Route 53, scenario-bundle S3 bucket (private, versioned, TLS-only), EKS Pod Identity role for the dispatcher (`s3:GetObject` on bundles), S3 + CloudFront + OAC frontend with SPA fallback and `app.dev.<domain>` alias records. Existing zone (`dns_zone_name`) or a new delegated zone (`create_dns_zone`).
- [x] `infra/aws/environments/dev` root on the existing backend (`dev.s3.tfbackend.example`, `dev.tfvars.example`); deletion protection off; `npm run infra:dev:init|plan|apply|destroy`.
- [x] S3 bundle mode end to end: `scripts/publish-scenarios.mjs` (`npm run scenarios:publish`) builds learner bundles, uploads bundle + sanitized manifest by digest, approves them with `scenarioArtifacts:approve --prod`; the dispatcher (`BUNDLE_MODE=s3`) presigns the approved key with Pod Identity credentials (`runner/shared/aws-sigv4.mjs`, dependency-free SigV4 checked against the AWS reference vector) and the pod's init container (the session image: curl + CA certificates) downloads, digest-checks and unpacks it (`pod-spec.mjs`); busybox was dropped after the first dev deploy because its wget cannot complete a TLS handshake with S3. `sessions.request` rejects scenarios without an approval; legacy rows without one are errored by the dispatcher, not launched.
- [x] Helm for dev: `values-dev.yaml` (ClusterIP gateway, https/443, secure cookies, dev page off, `baseline` PSA, larger quota) + `templates/ingress.yaml` (Auto Mode `IngressClassParams`/`IngressClass`, internet-facing ALB, ACM cert, TLS 1.3 policy, `/__llp/health` checks, 1 h idle timeout for WebSockets, wildcard host).
- [x] `scripts/deploy-dev.mjs` (`npm run deploy:dev [all|images|convex|chart|dns|scenarios|frontend|status|teardown]`): ECR login + multi-arch pushes recorded by digest, `convex deploy --yes` + seed, `helm upgrade` fed from `terraform output -json`, `*.dev.<domain>` CNAME upsert to the Ingress ALB, bundle publish, `vite build` → S3 sync → CloudFront invalidation, teardown before destroy. Runbook: `docs/dev-environment.md`.
- [x] Review fixes (2026-10-27, two independent Phase 5 reviews): ACM validation records keyed by domain per certificate (plan-time keys, `allow_overwrite`); NetworkPolicy actually enforced on Auto Mode (`kube-system/amazon-vpc-cni` ConfigMap applied by `deploy:dev chart`) with DNS egress to the cluster DNS service IP (`cluster_dns_ip` output → `sessions.dnsServiceIp`); `create_dns_zone` two-step apply documented; Kubernetes 1.34 with standard-support `upgrade_policy`; runner secret via a 0600 values file, redacted from errors, `checksum/secret` pod annotations, Convex before the chart; optional `CONVEX_DEPLOY_KEY` pin + `HOSTED_ENVIRONMENT` check; frontend `assets/*` immutable and everything else `no-cache` (no `--delete`), CSP `frame-ancestors 'none'`; `deploy:dev teardown`; dispatcher: only a missing approval is terminal (presign/credential errors retry until the startup timeout), credentials refreshed while they outlive a presign, pods shaped by `hostedScenario.runtime`, `karpenter.sh/do-not-disrupt`, init-container download retries, IAM narrowed to `scenarios/*/bundles/sha256/*`; gateway keep-alive > ALB idle, `preStop` sleep, PDB, topology spread; ECR lifecycle (10 tagged, untagged after 7 days); `-dirty` image tags; `IMAGE_PLATFORMS`/`PLATFORMS` override.
- [ ] Phase 4 security gaps, now internet-reachable on dev — fix before inviting anyone: make `labs.seedScenarios` internal (the deploy runs it with deploy access via `npx convex run`), operator-gate `/admin` (UI and the Convex functions behind it), `listMine` on `by_session_owner` for sessions and progress, and verify on dev that the backend refuses `ALLOW_UNAUTHENTICATED_LOCAL_MODE` when `HOSTED_ENVIRONMENT=dev` (`convex/access.ts`).
- [x] Applied on the account 2026-10-27/28: `npm run infra:dev:apply` (59 resources; `rumothy.com` zone, 1.34 Auto Mode), Convex env on `upbeat-crab-254` (`CLERK_JWT_ISSUER_DOMAIN`, `HOSTED_ENVIRONMENT=dev`, `RUNNER_SHARED_SECRET`, deploy key in `.env.dev`), legacy rows cleared, `npm run deploy:dev` end to end.
- [x] First-deploy fixes (2026-10-28): `.env.dev` must point `VITE_CONVEX_URL` at `upbeat-crab-254` (a copy of `.env.local` built the frontend and the chart against the local dev deployment); the Clerk publishable key must belong to the instance Convex trusts (`amazed-adder-35`, not the parked production app's dev instance); busybox cannot complete a TLS handshake with S3, so the bundle init container runs in the session image with `curl` (and GNU `sha256sum` has no `-s`); the dispatcher now records which container died and its exit code in the session error; the editor iframe keeps its layout while hidden (`visibility`, not `display:none` — VS Code web never recovers from a zero-size start) and is not sandboxed (VS Code web does not start in a sandboxed frame); OpenVSCode runs with `--disable-workspace-trust` (a `product.json` `configurationDefaults` entry is not forwarded to the web client); verify output is shown without ANSI codes.
- [x] Verified on dev from a desktop browser 2026-10-28: sign-in, `git/first-commit` terminal (DNS, internet egress, in-cluster gateway blocked by the network policy, bundle unpacked), `react/welcome-message` end to end (START → failing check with test output → edit → FINISH passed → finish page), Stop → ended banner → new session (~40 s to Ready on a warm node).
- [x] Verified from a phone browser 2026-10-28.

Deviations: no ECR interface endpoints yet (layers come through the S3 gateway endpoint, ECR API calls through NAT); the `*.dev` gateway record is written by the deploy script rather than Terraform (the ALB is created by the Ingress); frontend build-time config comes from `.env.dev` rather than Terraform; `account-security` keeps its ECS-era GuardDuty check until EKS Runtime Monitoring is turned on.

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
