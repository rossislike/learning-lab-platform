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
| 2 | Session workspace image + agent | 🔜 **Next** |
| 3 | Dispatcher + gateway on kind | ⏳ Not started |
| 4 | Frontend rewrite (Killercoda shell) | ⏳ Not started (can start now against the seeded Convex data) |
| 5 | `dev` environment on EKS | ⏳ Not started (after 3) |
| 6 | CI, TTL reaper, alarms | ⏳ Not started |

Legend: ✅ done · 🔧 in progress · 🔜 next · ⏳ not started · ❌ dropped

**You are here:** Phases 0–1 are complete. Start Phase 2 with the
`session-workspace` image and the agent's `/pty` WebSocket; drive it with a
30-line xterm.js page against `scenarios/git/first-commit` before touching the
real frontend. Phase 4 can proceed in parallel against `labs.seedScenarios`.

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

- The `labs` table keeps its name until the Phase 4 frontend rewrite; v1-only fields became optional instead of being dropped, so the legacy local Docker runner still runs React scenarios (`templatePath`, `validationCommand`, `previewCommand` are derived from the v2 `react` block). `sessions.request` rejects terminal scenarios on the local runner until Phase 3.
- Playground slugs are `<area>-playground` (slugs are global) in a `playground/` directory.
- The hosted runtime contract (`scenarioArtifactApprovals.runtime`, `sessions.hostedScenario`) changed shape to the v2 fields; there is no migration. Any Convex deployment holding old approval/hostedScenario rows must have them cleared before the schema push (local dev deployments: `npx convex run` a one-off, or wipe the tables from the dashboard).

## Phase 2 — Session workspace image and agent 🔜

Exit: `docker run` of the image with a mounted scenario serves a working terminal to a 30-line xterm.js page and verifies a step.

- [ ] `images/session-workspace/Dockerfile`: Ubuntu, Node 22, git, OpenVSCode, non-root `learner`, `tini`. Multi-arch (arm64 + amd64).
- [ ] `runner/session-agent/`: HTTP + WS on `:7000` — `/healthz`, `/ready`, `WS /pty?id=`, `GET /steps/setup` (status of the scenario `setup` script, which the agent runs automatically in the background as soon as the pod is ready — START does not trigger it), `POST /steps/:i/verify`, `/editor/*` and `/preview/*` proxies. Scripts run exactly as `docs/scenario-authoring.md` specifies (`bash`, cwd = `workspace.cwd`, `LAB_*` env); react bundles copy `workspace/` to `workspace.cwd` before setup. Results go to `steps.recordStepResult`.
- [ ] Salvage process supervision and the readiness callback from the old `hosted-learner-entrypoint.mjs` (git history, up to and including commit `11916e0`).
- [ ] Session-bound callback token: dispatcher mints per session, agent presents it to Convex; Convex stores only its hash + expiry.
- [ ] Agent integration test driven by a script against the running container; point `SMOKE_IMAGE` at the new image and make it the smoke-test default.

## Phase 3 — Dispatcher and gateway on Kubernetes ⏳

Exit: `npm run dev:all` brings up Convex, Vite, kind, dispatcher, gateway; a session pod starts from the UI and the old Docker runner is deleted.

- [ ] `runner/k8s-dispatcher.mjs` (`@kubernetes/client-node`): poll Convex → Pod + headless Service in `sessions`; record pod IP + route ID; reap stopped/expired; reconcile on start; Convex lease for multi-replica safety.
- [ ] `runner/session-gateway.mjs`: implement ADR 0004 — bootstrap code → `HttpOnly` cookie bound to route ID; proxy `/s/:routeId/{pty,editor,preview,steps}/*` with WebSocket upgrade; ownership check per connection.
- [ ] `deploy/helm/learning-lab/`: namespaces, dispatcher, gateway, RBAC (pods/services in `sessions` only), default-deny `NetworkPolicy` + egress allow-list, `ResourceQuota`, pod limits.
- [ ] `deploy/kind/cluster.yaml` with port mapping `8080 → gateway`; `scripts/dev-supervisor.mjs` creates/loads/installs idempotently.
- [ ] Delete `runner/local-runner.mjs`, `workspace-server.mjs`, and the `local` runner enum.

## Phase 4 — Frontend rewrite ⏳

Exit: all Phase 1 scenarios run end-to-end on local/kind from the new UI.

- [ ] New `src/` with React Router; delete `App.tsx`. Switch to Convex `useQuery` subscriptions.
- [ ] `/` Areas grid with search; Playgrounds and Examples tiles first.
- [ ] `/:area` scenario cards with completion check marks from progress records.
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
