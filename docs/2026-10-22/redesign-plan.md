# Learning Lab Platform — Redesign Plan (2026-10-22)

Target experience: Killercoda-style (see `1.png`–`4.png` in this folder).

1. **Areas catalog** — grid of areas (Linux, Git, React, Kubernetes…) with search.
2. **Scenario grid** — per-area list of scenario cards with a completion check mark.
3. **Scenario shell** — left pane: scenario title, step dots, markdown instructions, collapsible hints/solution, `START` / `BACK` / `NEXT`. Right pane: tabbed workspace (`Terminal`, `Editor`, `Preview`, `+` extra terminals), TTL countdown in the header.
4. The terminal is the primary surface. VS Code (OpenVSCode) stays as a tab for React scenarios, with the Vite preview as a third tab.

Two environments only: **local** (laptop) and **dev** (AWS, EKS).

---

## 1. Where the project is today

| Layer | Current state | Verdict |
|---|---|---|
| Frontend (`src/App.tsx`, 2,979 lines, one file) | Operator dashboard: seed scenarios, request session, sessions table, events, runner health, editor/preview split. Built around *sessions*, not *scenarios*. | **Rewrite.** Nothing in the UI matches the target. Keep the Clerk wiring and the Convex polling client pattern. |
| Control plane (`convex/`) | Solid: users, courses/modules, labs, sessions (10 states), sessionEvents, progressRecords, runnerHeartbeats, scenarioArtifactApprovals. Access checks, lifecycle, tests. | **Keep, extend.** Add step model, step progress, terminal URL, `runner: "kubernetes"`. Drop `aws-ecs-fargate` and the staging/production artifact-approval environment enum. |
| Scenario model (`lab-definitions/*/manifest.json`) | React-only: one workspace template, one `validationCommand`, one README + CHECKLIST. No steps. | **Replace with manifest v2** (steps, scripts, `kind: terminal \| react`). Convert the 4 React labs. |
| Local runner (`runner/local-runner.mjs`, 845 lines) | Polls Convex, runs OpenVSCode in Docker, Vite preview + tools server as host processes, port allocation, cleanup. Works. | **Retire.** Replaced by one Kubernetes dispatcher that runs against kind locally and EKS in dev (one code path). |
| Hosted runner (`runner/aws-runner.mjs`, `aws-ecs-fargate-runner.mjs`, `hosted-learner-entrypoint.mjs`) | ECS Fargate dispatcher + learner entrypoint. Never ran real learner traffic. | **Retire** ECS pieces. Salvage `hosted-learner-entrypoint.mjs` (process supervision, readiness callback) into the new session agent. |
| Session gateway (`runner/session-gateway.mjs`, 71 lines, ADR 0004) | Stub. Bootstrap-code/cookie design is written, not implemented. | **Implement for real** — it becomes the only ingress to session pods and the WebSocket proxy for terminals. |
| Infra (`infra/aws/`) | Terraform backend + account-security stack are live. `environments/staging` and `environments/production` are destroyed (empty state). `modules/hosted-runner` is ECS-specific. | **Keep** bootstrap + account-security. **Delete** staging/production roots and the ECS module. **Add** `modules/eks-platform` and `environments/dev`. |
| Identity | Clerk dev instance (shared dev/staging) + production instance. Convex `prod:upbeat-crab-254` (staging) and `prod:aware-fish-663` (production). | **Keep** the Clerk dev instance for both local and dev. Reuse `upbeat-crab-254` as the *dev* Convex deployment. Leave the production Clerk/Convex resources parked; nothing references them. |
| Roadmap | 8-phase ECS launch plan, mostly unchecked, built for staging→production promotion. | **Rewrite** around the phases below. |

Decision to record: **ADR 0001 chose ECS/Fargate and explicitly rejected EKS.** This plan supersedes it with ADR 0005 (EKS). The honest reason is forward-looking: terminal scenarios will eventually want a real `kubectl`, and a per-session pod model (plus vcluster later) gets there; ECS never does.

---

## 2. Target architecture

```
Browser ──Clerk JWT──▶ Convex (scenarios, sessions, steps, progress)
   │                        ▲
   │ HTTPS + WSS            │ poll / callbacks
   ▼                        │
Session Gateway (k8s Deployment, behind ALB, wildcard *.dev.<domain>)
   │  cookie auth (ADR 0004), routeId → pod IP, WS proxy
   ▼
Session Pod (one per learner session, namespace `sessions`)
   └── container "workspace" : session-agent (Node)
         ├── PTY server  (node-pty ⇄ WebSocket)       → Terminal tabs
         ├── OpenVSCode   (localhost:3000, proxied)    → Editor tab
         ├── Vite dev     (localhost:5173, proxied)    → Preview tab (react kind)
         └── step runner  (setup / verify scripts)     → START / NEXT

Dispatcher (k8s Deployment): polls Convex for `requested` sessions,
  creates Pod + ttl annotation, writes readiness, reaps expired/stopped pods.
```

- **Local** = Docker Desktop + `kind` cluster. Same Helm chart, same images, same dispatcher/gateway. Gateway reachable at `http://localhost:8080`; no TLS, no Clerk required (`VITE_AUTH_MODE=disabled` stays supported).
- **Dev** = EKS **Auto Mode** (no node groups to manage; built-in ALB controller, EBS, CoreDNS). Private subnets for pods. ALB with ACM wildcard cert → gateway Service. Frontend on S3 + CloudFront. Images in ECR.
- One image, `learning-lab/session-workspace`, contains bash, coreutils, git, node 22, OpenVSCode, the session agent. Scenario content is injected at start (initContainer pulls the scenario bundle from S3 in dev, from a hostPath/ConfigMap in local).
- Pod limits: CPU/mem/ephemeral-storage requests+limits, `runAsNonRoot` where the scenario allows (terminal scenarios that teach `root` can opt in via manifest, with a `NetworkPolicy` and no privileged mode either way).
- Kubernetes-API scenarios (CKA-style) are **out of scope for this plan**. Noted as the next step (vcluster per session) so the pod model is chosen with it in mind.

---

## 3. Scenario manifest v2

Killercoda's shape, adapted. One directory per scenario:

```
scenarios/<area>/<slug>/
  manifest.json
  intro.md
  step1.md … stepN.md
  finish.md
  scripts/
    setup.sh          # runs before intro is shown (background)
    step1-verify.sh   # exit 0 = pass
    step2-setup.sh    # optional per-step
  workspace/          # react kind: the Vite project copied to /workspace
  solution/           # optional, for smoke tests
```

```jsonc
{
  "schemaVersion": 2,
  "slug": "git-first-commit",
  "area": "git",                       // drives the Areas catalog
  "kind": "terminal",                  // "terminal" | "react"
  "title": "Your First Commit",
  "summary": "Init a repo, stage, commit.",
  "difficulty": "easy",
  "ttlSeconds": 3600,
  "tabs": ["terminal"],                // react kind: ["terminal","editor","preview"]
  "workspace": { "cwd": "/workspace", "user": "learner" },
  "steps": [
    { "title": "Initialise a repository", "content": "step1.md", "verify": "scripts/step1-verify.sh" },
    { "title": "Stage and commit",        "content": "step2.md", "verify": "scripts/step2-verify.sh" }
  ],
  "react": null                        // react kind: { previewPort, installCommand, devCommand, testCommand }
}
```

Behavior: `START` runs `setup.sh`, then shows step 1. `NEXT` runs the step's `verify` script; failure shows the script's stdout as the remediation message and keeps the learner on the step. Collapsible blocks in markdown (`<details>`) give the Hint/Solution panels from screenshot 4.

Convex additions: `scenarios.steps[]` (denormalized from manifest), `sessions.currentStep`, `sessionSteps` table (`sessionId, stepIndex, status, verifiedAt, output`). `progressRecords` gains `completedSteps`.

---

## 4. Phases

Each phase ends with something runnable. Order is chosen so the UI can be built against local long before AWS exists.

### Phase 0 — Decide and clear the deck (½ day)
- ADR 0005 *Hosted execution model: EKS* (supersedes 0001). ADR 0006 *Scenario manifest v2 and step model*. ADR 0007 *Environments: local and dev only*.
- Delete `infra/aws/environments/{staging,production}`, `infra/aws/modules/hosted-runner`, `runner/aws-*`, `runner/hosted-*`, `scripts/*teardown*`, `scripts/validate-*`, the ECS tests, `config/hosted-environments.json` (replace with a 2-env version). Keep `bootstrap/` and `account-security/`.
- Rewrite `ROADMAP.md` from this document. Trim `README.md` to the new architecture.
- Drop the `aws-ecs-fargate` runner enum from the schema; add `kubernetes`. Drop the staging/production enum on `scenarioArtifactApprovals` (keep the table — digest-pinned bundles are still how dev gets scenario content).

### Phase 1 — Scenario model v2 and content (1–2 days)
- `scripts/import-scenarios.mjs` → reads manifest v2, validates with a JSON schema, upserts `scenarios` + `steps` in Convex, bundles `scenarios/<area>/<slug>` into a tarball with a sha256.
- Convert the 4 React labs into `scenarios/react/*` with 2–4 steps each (the existing README/CHECKLIST text becomes step content; the vitest command becomes the final step's verify).
- Author 3 terminal scenarios to prove the model: `linux/filesystem-basics`, `git/first-commit`, `node/cli-tool`. Plus one `playground` per area (no steps, just a shell).
- `scripts/smoke-test-scenarios.mjs` → runs setup + each verify against `solution/` in a throwaway container.

### Phase 2 — Session workspace image + agent (2–3 days)
- `images/session-workspace/Dockerfile`: Ubuntu base, node 22, git, OpenVSCode, non-root `learner` user, `tini`.
- `runner/session-agent/` (new, Node): HTTP+WS on `:7000`.
  - `GET /healthz`, `GET /ready`
  - `WS /pty?id=<n>` → node-pty (bash, cwd from manifest). Multiple terminals per session.
  - `POST /steps/:i/verify`, `POST /steps/setup` → runs scripts, streams output, reports result to Convex via the session-bound token (reuse the callback-token design from the ECS plan — it is runner-agnostic).
  - `/editor/*` → proxy to OpenVSCode; `/preview/*` → proxy to Vite (react kind only).
- Salvage process supervision + readiness callback from `hosted-learner-entrypoint.mjs`.
- Test: `docker run` the image with a scenario bundle mounted, drive the agent with a script.

### Phase 3 — Dispatcher + gateway on Kubernetes (2–3 days)
- `runner/k8s-dispatcher.mjs`: polls Convex (same shape as today's runners), `@kubernetes/client-node` creates a Pod + headless Service per session in namespace `sessions`, labels `session=<id>`, annotates `expiresAt`; records pod IP + routeId in Convex; reaps stopped/expired pods; reconciles on restart (list pods ↔ Convex sessions). Convex lease so two replicas don't double-launch.
- `runner/session-gateway.mjs`: implement ADR 0004 — `GET /bootstrap/:code` sets an `HttpOnly` cookie bound to `routeId`; `/s/:routeId/{pty,editor,preview,steps}/*` proxied to pod IP:7000 (`http-proxy` with WS upgrade). Ownership check against Convex on every new connection.
- `deploy/helm/learning-lab/`: namespaces, dispatcher, gateway, RBAC (dispatcher may create/delete pods only in `sessions`), `NetworkPolicy` (sessions → egress only to allowlist; gateway → sessions:7000; nothing else inbound), `ResourceQuota` on `sessions`.
- Local: `kind` config with port mapping 8080 → gateway. `npm run dev:all` becomes: `convex dev` + `vite` + `kind create` (idempotent) + `helm upgrade --install` + `kind load docker-image`.

### Phase 4 — Frontend rewrite (3–4 days)
Fresh `src/` with React Router; delete `App.tsx`. Keep Clerk provider + `ConvexHttpClient` polling (or switch to `useQuery` subscriptions now that there is one client — recommended).
- `/` — Areas grid (screenshot 1). Playgrounds + Examples tiles first, then areas.
- `/:area` — scenario cards (screenshot 2), check mark from `progressRecords`.
- `/:area/:slug` — scenario shell (screenshots 3–4):
  - Left `InstructionPane`: title, step dots, markdown (react-markdown + `<details>` support + code blocks with click-to-run-in-terminal), `START` → `BACK`/`NEXT`, verify feedback inline.
  - Right `WorkspacePane`: tab strip `Terminal 1 | Editor | Preview | +`; `Terminal` = xterm.js over the gateway WS; `Editor` = iframe `/s/:routeId/editor/`; `Preview` = iframe `/s/:routeId/preview/`. Header: TTL countdown, stop.
  - States: `requested/starting` → "Initialising scenario…" line in the terminal pane; `errored/expired` → modal with retry.
- `/admin` — the useful remnants of today's dashboard: sessions table, runner heartbeat, import scenarios. Operator-only.
- Styling: dark terminal pane, light instruction pane, as in the screenshots; single `styles.css` → CSS modules or Tailwind (either is fine; pick one).
- Done when all 7 scenarios from Phase 1 run end-to-end on local/kind.

### Phase 5 — Dev environment on EKS (2–3 days, after Phase 3 works on kind)
- `infra/aws/modules/eks-platform`: VPC (2 AZ, private pod subnets, NAT), EKS Auto Mode cluster, ECR repos (`session-workspace`, `dispatcher`, `gateway`), ACM wildcard cert + Route 53 `*.dev.<domain>` and `app.dev.<domain>`, S3 bucket for scenario bundles (create-only policy, reuse existing), IRSA roles for dispatcher (S3 read-presign) and gateway (none), CloudWatch log group, S3 + CloudFront + OAC for the frontend.
- `infra/aws/environments/dev`: one root, one tfvars, own state key in the existing backend. Deletion protection off (it is dev).
- Helm values for dev: ALB Ingress (`alb.ingress.kubernetes.io/scheme: internet-facing`, cert ARN), wildcard host, image digests.
- Convex: deploy to `upbeat-crab-254` (rename conceptually to dev). Clerk: dev instance, add `app.dev.<domain>` to allowed origins.
- `npm run infra:dev:plan|apply`, `npm run deploy:dev` (build → push ECR → helm upgrade → convex deploy → sync frontend to S3 + invalidate).
- Exit: a React and a terminal scenario run end-to-end from a phone browser against dev.

### Phase 6 — CI and hygiene (1–2 days)
- GitHub Actions: lint/test on PR; on `main`: build images (ARM64 for Auto Mode Graviton nodes or amd64 — pick one and pin; decided in ADR 0005: multi-arch, arm64 + amd64), push by digest, `helm upgrade` dev, publish scenario bundles, deploy Convex, sync frontend. Reuse the existing OIDC role work from `modules/github-image-delivery`.
- Pod `ttl` reaper as a CronJob in-cluster (replaces the ECS TTL Lambda).
- Minimal alarms: gateway 5xx, dispatcher heartbeat stale, pod launch failures, daily cost budget on the account.
- Scenario smoke test in CI against kind.

Rough total: 3–4 weeks of focused work. Phases 1, 2 and 4 can proceed in parallel after Phase 0.

---

## 5. Decisions I made that you should confirm

1. **Local = kind, not plain Docker.** One dispatcher code path for both environments; costs ~2 min of kind startup and ~2 GB RAM. Alternative: keep a slimmed Docker-only local runner (faster, but two runners to maintain).
2. **EKS Auto Mode** rather than managed node groups. Less to operate, slightly more per-node cost, nodes are Graviton by default (so images build ARM64). Alternative: managed node group + manual ALB controller/Karpenter.
3. **Kubernetes-API scenarios are deferred.** The session-pod model is compatible with adding `vcluster` later; nothing in this plan blocks it.
4. **Terminal transport = node-pty in the session agent + xterm.js**, proxied through the gateway (no ttyd/gotty). Keeps auth in one place.
5. **Production Clerk/Convex resources stay parked**, not deleted. Zero cost, and they are not wired to anything.
6. **Frontend data layer switches to Convex `useQuery` subscriptions** instead of manual `ConvexHttpClient` polling. The polling existed to work around multi-deployment confusion that goes away with two clear environments.

## 6. First concrete steps

1. Phase 0 cleanup commit (deletions + 3 ADRs + new ROADMAP).
2. Author `scenarios/git/first-commit` by hand as the reference scenario; write the JSON schema from it.
3. Build the session-workspace image and the agent; run one terminal scenario with `docker run` and a 30-line HTML xterm page before touching the real frontend.
