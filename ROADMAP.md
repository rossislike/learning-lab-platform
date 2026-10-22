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
| 1 | Scenario manifest v2 + content | 🔜 **Next** |
| 2 | Session workspace image + agent | ⏳ Not started (can run in parallel with 1) |
| 3 | Dispatcher + gateway on kind | ⏳ Not started |
| 4 | Frontend rewrite (Killercoda shell) | ⏳ Not started (can start against mocks after 1) |
| 5 | `dev` environment on EKS | ⏳ Not started (after 3) |
| 6 | CI, TTL reaper, alarms | ⏳ Not started |

Legend: ✅ done · 🔧 in progress · 🔜 next · ⏳ not started · ❌ dropped

**You are here:** Phase 0 is complete. Start Phase 1 with the reference
scenario `scenarios/git/first-commit`, then the JSON schema, then the importer.

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

## Phase 1 — Scenario manifest v2 and content 🔜

Exit: seven v2 scenarios import cleanly and pass the smoke test.

- [ ] Author `scenarios/git/first-commit` by hand as the reference scenario (intro, 3 steps, finish, verify scripts, solution).
- [ ] Write `scenarios/manifest.schema.json` (JSON Schema for v2) from the reference.
- [ ] Rewrite `scripts/import-scenarios.mjs`: validate against the schema, upsert `scenarios` + `steps` in Convex, bundle to a digest-named tarball.
- [ ] Convex: add `steps` to scenarios, `currentStep` + `sessionSteps`, `completedSteps` on progress records. Rename `labs` → `scenarios` (or alias) and drop v1-only fields.
- [ ] Convert the four React labs to v2 (2–4 steps each; vitest becomes the final verify). Delete `lab-definitions/`.
- [ ] Author `linux/filesystem-basics` and `node/cli-tool`.
- [ ] Add one zero-step `playground` per area.
- [ ] Rewrite `scripts/smoke-test-scenarios.mjs` for v2: run `setup.sh`, apply `solution/`, run every verify in a throwaway `session-workspace` container.

## Phase 2 — Session workspace image and agent ⏳

Exit: `docker run` of the image with a mounted scenario serves a working terminal to a 30-line xterm.js page and verifies a step.

- [ ] `images/session-workspace/Dockerfile`: Ubuntu, Node 22, git, OpenVSCode, non-root `learner`, `tini`. Multi-arch (arm64 + amd64).
- [ ] `runner/session-agent/`: HTTP + WS on `:7000` — `/healthz`, `/ready`, `WS /pty?id=`, `POST /steps/setup`, `POST /steps/:i/verify`, `/editor/*` and `/preview/*` proxies.
- [ ] Salvage process supervision and the readiness callback from the old `hosted-learner-entrypoint.mjs` (git history, up to and including commit `11916e0`).
- [ ] Session-bound callback token: dispatcher mints per session, agent presents it to Convex; Convex stores only its hash + expiry.
- [ ] Agent integration test driven by a script against the running container.

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
- [ ] Clear legacy `staging`/`aws-ecs-fargate` rows from `scenarioArtifactApprovals`, `sessions`, `runnerHeartbeats` on `upbeat-crab-254` (or run a one-off internalMutation) before the first schema push.
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
