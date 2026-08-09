# Learning Lab Platform Roadmap

This roadmap tracks the local MVP and the path toward a hosted Killercoda-like learning platform.

## Current State

- [x] Build a local Convex-backed control plane for labs, sessions, session events, runner state, validation results, and cleanup metadata.
- [x] Build a React/Vite dashboard for seeding scenarios, requesting sessions, refreshing state, running checks, stopping sessions, and inspecting events.
- [x] Use explicit `ConvexHttpClient` polling so dashboard state reliably reflects the current Convex deployment.
- [x] Implement local Docker/OpenVSCode session startup.
- [x] Open OpenVSCode at the exercise root folder.
- [x] Start a per-session Vite preview process.
- [x] Start a per-session tools/check server.
- [x] Keep validation learner-triggered instead of running checks automatically on startup.
- [x] Support session lifecycle states: `requested`, `starting`, `running`, `checking`, `passed`, `failed`, `stopped`, `errored`, and `expired`.
- [x] Add stop and cleanup support for local containers, preview processes, and tools servers.
- [x] Add TTL expiry cleanup support.
- [x] Embed editor and preview on the same workspace page.
- [x] Split the app into Dashboard and Editor/Preview tabs.
- [x] Collapse the left navigation on the Editor/Preview tab.
- [x] Add a resizable editor/preview split and persist the layout in `localStorage`.
- [x] Add a scenario catalog grouped by React domains.
- [x] Seed the `Update Welcome Message` easy scenario.
- [x] Seed the `Optimize Product Dashboard` rendering optimization scenario.
- [x] Keep sessions tied to `labId` so existing sessions remain valid.
- [x] Show a dashboard notice when local sessions are queued but the local runner is not running.
- [x] Preserve useful validation failure details, including expected and actual heading text for the welcome scenario.

## Near-Term Stabilization

- [x] Add an explicit Clerk sign-out control for authenticated users.
- [x] Represent runner cleanup as `stopping` and only mark a session `stopped` after its resources are removed.
- [x] Update README wording and screenshots to match the current multi-scenario flow, including `Seed scenarios`.
- [x] Add the scenario title/domain to session rows and session detail.
- [x] Improve current-session selection so the Workspace tab always opens the intended selected session.
- [x] Add a first-class runner health block that shows whether the local runner is actively polling.
- [x] Add clearer queued, running, passed, failed, stopped, and expired empty states.
- [x] Add stale-session detection for editor/preview/tools URLs that no longer respond.
- [x] Add a one-click cleanup affordance for stopped/expired local sessions.
- [x] Add a "Remove Session from list" button in the Recent Sessions table, with a dedicated actions column.
- [x] Make validation results easier for learners to read without exposing raw test-runner language first.

## Scenario Authoring

- [x] Define and document the stable scenario manifest contract.
- [x] Standardize starter README, checklist, tests, expected commands, and difficulty metadata across scenarios.
- [x] Add an authoring/import script for new scenarios.
- [x] Add at least two more easy React scenarios to prove the scenario model scales.
- [x] Add a scenario smoke-test command that copies a template, installs dependencies, runs the initial failing check, applies a known solution, and confirms the passing check.
- [x] Add lint/build/test expectations for scenario templates.
- [x] Decide whether scenarios need solutions committed alongside starters for author verification.

## Workspace UX

- [x] Add a task/instructions panel inside the Workspace tab.
- [x] Show checklist progress next to the editor/preview.
- [x] Add a visible save/check guidance state for OpenVSCode edits.
- [x] Keep standalone OpenVSCode, preview, and tools links available from the workspace.
- [x] Add pass-state next steps after a learner completes a scenario.
- [x] Add fail-state remediation that points to the relevant file and expected behavior.
- [x] Improve responsive layout for smaller screens.

## Runner Reliability

- [x] Add a runner heartbeat in Convex.
- [x] Display runner heartbeat and last poll time in the dashboard.
- [x] Detect and report dead editor, preview, or tools processes.
- [x] Make local runner startup idempotent across process restarts.
- [x] Reconcile Convex session state with actual local Docker/process state on each poll.
- [x] Improve logs for Docker image pull failures, port allocation, dependency install failures, and validation command failures.
- [x] Add a supervised local development mode that starts Convex, dashboard, and runner together.

## Session And Progress Model

- [x] Add session filtering by scenario, status, and learner label.
- [x] Add per-scenario session history.
- [x] Add completed-at timestamps.
- [x] Decide how long completed local workspaces should remain inspectable.
- [x] Add attempt summaries per scenario.
- [x] Add durable progress records separate from disposable sessions.

## Product Readiness

- [x] Define learner, operator, and author personas.
- [x] Decide whether the first product surface is single-learner, instructor-led, or self-serve.
- [x] Add authentication before any hosted/public deployment.
- [x] Add authorization boundaries around sessions and workspace URLs.
- [x] Add a basic course/module structure above scenarios.
- [x] Add observability for session startup time, validation time, failure rates, and resource cleanup.
- [x] Add cost controls before running hosted workloads.

## AWS Migration

- [x] Preserve the local runner interface while adding an AWS runner implementation.
- [x] Decide the hosted execution model: ECS/Fargate first unless requirements force EKS/KubeVirt.
- [x] Define workspace storage strategy for hosted sessions.
- [x] Define routing for editor, preview, and tools URLs.
- [x] Add secure per-session URL access.
- [x] Implement hosted TTL cleanup.
- [x] Add infrastructure as code under `infra/`.
- [x] Validate one hosted React scenario end to end inside Fargate, including the expected starter failure and solution pass.

## AWS Hosted Launch Plan

The hosted architecture uses three ECS workloads with separate responsibilities:

- an ECS service for the trusted AWS dispatcher;
- an ECS service for the authenticated session gateway;
- one standalone Fargate task for each learner session.

The local runner remains the default local development path throughout this migration.

Promotion follows one direction: reusable Terraform modules and application artifacts, staging deployment and qualification, then production deployment. Production enablement is blocked unless every security, quota, cost, recovery, and regression gate below passes.

### 1. Environment Foundation

- [x] Implement the Terraform bootstrap stack for a private, versioned, KMS-encrypted state bucket and native S3 lock files outside the runner stack.
- [x] Deploy the production state backend in the verified production AWS account, migrate bootstrap state, and prove native lock contention, version-copy recovery, KMS-encrypted reads, and backup comparison.
- [x] Restore a copied state version into an isolated backend and run Terraform against it to rehearse the full backup restoration procedure.
- [x] Rehearse KMS disable and re-enable recovery with an isolated key and copied state before any production break-glass exercise.
- [x] Build reusable, versioned Terraform modules before instantiating staging or production; create separate variable sets, state, deletion protection, and immutable image inputs for each environment.
- [ ] Isolate production from staging in separate AWS accounts, with separate Clerk applications and Convex deployments; document any temporary exception and its migration deadline. A blocking inventory exception and automated readiness gate are documented in `docs/environment-isolation.md`; external staging and production identities remain to be provisioned by 2026-08-12.
- [x] Configure staging first, then production, with private subnets, ECS clusters, ECR repositories, S3 buckets, KMS keys, and CloudWatch log groups.
- [x] Make network boundaries explicit: only the ALB reaches gateway security groups, only the gateway reaches session ports, dispatcher tasks have no inbound path, session tasks cannot reach other sessions, and egress is allowlisted through endpoints or a controlled proxy.
- [x] Block task access to EC2 instance metadata and unrelated link-local endpoints; use ECS task metadata only where required and never expose its output to learner processes.
- [x] Use IAM Identity Center temporary sessions for human operator access, store the dispatcher control-plane credential in AWS Secrets Manager, grant secret retrieval only to its dedicated ECS execution role during task startup, and grant runtime AWS API permissions to a separate, narrowly scoped task role.
- [x] Add ACM certificates and Route 53 records for the hosted application and wildcard workspace domain.
- [x] Add AWS WAF, ALB access logs, CloudTrail coverage, GuardDuty Runtime Monitoring, and security alarms.
- [x] Define environment ownership, operator access, emergency access, secret rotation, and production change procedures.

### 2. Versioned ECS Images And Delivery

- [ ] Build a production learner-session image that starts OpenVSCode, preview, and tools services without Docker-in-Docker or privileged mode.
- [ ] Build separate production images for the AWS dispatcher and session gateway.
- [ ] Publish immutable, digest-addressed scenario artifacts and manifests to the environment artifact bucket before any hosted session can reference them; record the approved digest in Convex.
- [ ] Add CI image builds for ARM64, vulnerability scanning, software bills of materials, image signing, and immutable digest promotion.
- [ ] Pin every ECS task definition to an approved image digest and retain every digest referenced by an active task definition.
- [ ] Add staged task-definition promotion with automated rollback when deployment health checks fail.

### 3. Trusted AWS Dispatcher Service

- [ ] Package `runner/aws-runner.mjs` as a continuously running ECS service in private subnets.
- [ ] Replace reusable runner and Convex credentials with dispatcher workload identity and a session-bound callback protocol: the dispatcher mints a random, single-session, purpose-scoped credential with a short expiry; stores only its hash and expiry in Convex; injects it from a dedicated Secrets Manager entry through the ECS execution role; deletes that entry after task startup; and rejects replay, wrong session, wrong operation, or expired callbacks.
- [ ] Prefer dispatcher-mediated readiness, validation, checkpoint, and lifecycle updates so learner tasks never receive a general Convex credential; document the narrowly scoped callback endpoint and rotation or revocation behavior for any direct callback that remains.
- [ ] Give the dispatcher only the ECS, networking, tagging, route-registration, presigning, and cleanup permissions it requires.
- [ ] Add leader election or a Convex lease so multiple dispatcher tasks can run safely without duplicate session launches.
- [ ] Reconcile Convex session state with ECS task state after restarts, timeouts, partial launches, and missed cleanup events.
- [ ] Make task launch idempotent with deterministic client tokens, capacity-provider configuration, and bounded retries.
- [ ] Publish dispatcher heartbeats, launch latency, reconciliation failures, task capacity failures, and cleanup backlog metrics.

### 4. Interactive Standalone Session Tasks

- [ ] Replace the validation-only container command with the interactive learner-session entrypoint.
- [ ] Download one authorized scenario artifact through a short-lived, exact-key presigned URL and extract it safely.
- [ ] Start the editor, preview, and tools processes on fixed internal ports with container health checks.
- [ ] Report readiness and endpoint health through the session-bound callback or dispatcher-mediated protocol; let the trusted dispatcher discover and record private task IP, task ARN, and image digest.
- [ ] Enforce CPU, memory, ephemeral-storage, process, file-size, network, and session-duration limits inside each task.
- [ ] Upload bounded checkpoints through short-lived exact-key presigned URLs and restore the latest authorized checkpoint after task replacement.
- [ ] Run artifact and checkpoint URL presigning plus checkpoint deletion from a dedicated trusted service or dispatcher component, never from learner tasks; make deletion idempotent, retention-driven, observable, and independently reconciled.
- [ ] Stop promptly on learner request, TTL expiry, account revocation, dispatcher reconciliation, or platform shutdown.
- [ ] Prove that a stop during task startup cannot publish a usable route and always cleans any partially created resources.

### 5. Session Gateway And Secure Routing

- [ ] Implement the session gateway as a stateless ECS service across at least two Availability Zones.
- [ ] Put the gateway behind an internet-facing ALB with HTTPS-only listeners and wildcard workspace routing.
- [ ] Implement endpoint-bound one-time bootstrap codes, host-only `HttpOnly` cookies, bounded revocation, and authenticated ownership checks from ADR 0004.
- [ ] Resolve opaque route IDs to healthy private task IPs without exposing ECS identifiers or private addresses to browsers.
- [ ] Proxy editor WebSockets, preview HTTP traffic, and tools requests with correct timeout, streaming, and size limits.
- [ ] Remove routes before task shutdown and deny stale, revoked, cross-user, and cross-endpoint access.
- [ ] Add rate limits, request IDs, structured audit logs, security headers, and origin validation.

### 6. Hosted Application And Account Integration

- [ ] Host the React application as immutable static assets in a private S3 origin behind CloudFront with Origin Access Control, HTTPS, security headers, cache-versioned releases, and a documented rollback to the prior asset manifest.
- [ ] Deploy the React application with `VITE_PRODUCT_SURFACE=hosted`, Clerk configured, authorized session access, and enforced cost controls.
- [ ] Configure production Clerk keys, the `convex` JWT template, Convex issuer validation, allowed origins, and account-management URLs.
- [ ] Create isolated staging and production Convex deployments, promote schema and functions through CI, seed or migrate production reference data idempotently, back up durable learner data before migrations, and verify forward and rollback compatibility.
- [ ] Move hosted session requests to `aws-ecs-fargate` while keeping local development on the local runner.
- [ ] Issue workspace bootstrap codes only to the authenticated session owner and never place bearer credentials in workspace URLs.
- [ ] Implement signed, idempotent Clerk deletion webhooks and the approved learning-data retention or anonymization policy.
- [ ] Add learner-facing startup, stopping, recovery, capacity, and retry states for ECS-backed sessions.

### 7. Reliability, Security, And Cost Gates

- [ ] Add alarms for dispatcher health, gateway health, ALB errors, ECS launch failures, startup latency, cleanup backlog, expired tasks, and NAT or data-transfer anomalies.
- [ ] Add ECS deployment circuit breakers, minimum healthy capacity, health-check grace periods, autoscaling bounds, capacity-provider strategy, graceful draining, deployment rollback, and explicit Fargate capacity-error handling.
- [ ] Implement and verify per-user and global concurrency quotas, launch-rate limits, maximum TTLs, artifact-size limits, and an operator-tested production kill switch before enabling any hosted learner traffic.
- [ ] Add CloudWatch dashboards and operational runbooks for launch failure, route failure, stuck cleanup, secret rotation, image rollback, and regional impairment.
- [ ] Execute the ADR 0004 security suite for bootstrap replay, endpoint swapping, cookie scope, CSRF and origin rejection, cross-user denial, support grants, sign-out revocation, stale routes, log redaction, and hostile preview content.
- [ ] Run dependency, container, infrastructure, IAM, network, and application security reviews with no unresolved critical or high findings.
- [ ] Perform load tests for concurrent launches, gateway WebSockets, task churn, checkpoint traffic, and Convex control-plane load.
- [ ] Run failure injection for dispatcher restarts, gateway task loss, ECS capacity errors, partial startup, lost callbacks, and cleanup retries.
- [ ] Define recovery objectives for Convex data, S3 artifacts and checkpoints, routing state, Terraform state, and container availability; document RTO, RPO, backup ownership, and regional recovery order.
- [ ] Measure per-session compute, NAT, storage, logging, and gateway costs; make CI or promotion fail when forecast or measured cost exceeds approved per-session, daily, or monthly thresholds; configure budgets and anomaly detection.

### 8. Staging And Production Rollout

- [ ] Create one coordinated CI/CD workflow that validates Terraform plans, publishes signed images and scenario artifacts, deploys Convex functions and data migrations, applies staging infrastructure, deploys ECS services and frontend assets, runs smoke tests, detects drift, and promotes the same digests to production with approval and component-level rollback.
- [ ] Deploy the complete architecture to staging from CI using production-equivalent networking and security controls before creating or changing production workloads.
- [ ] Pass automated end-to-end tests for sign-up, sign-in, launch, editor access, preview, checks, checkpoint recovery, stop, TTL expiry, sign-out, and cross-user denial.
- [ ] Run the complete local-runner end-to-end suite in CI and block promotion on any regression to local session launch, checks, stop, cleanup, or auth-disabled development.
- [ ] Run a controlled staging soak with repeated task creation and cleanup until no orphaned tasks, routes, network interfaces, or artifacts remain.
- [ ] Complete backup, restore, rollback, incident-response, and disaster-recovery exercises.
- [ ] Deploy production through an approval-gated pipeline and run a small internal canary cohort.
- [ ] Expand availability only after service-level objectives, security gates, cost limits, and rollback criteria remain healthy through the canary period.
- [ ] Record the production evidence and mark AWS migration complete only after real learner sessions run exclusively on standalone ECS tasks.

## Later Multi-User Platform

- [x] Add user accounts.
- [ ] Add organizations or teams.
- [ ] Add course enrollment and learner progress.
- [ ] Add role-based access for learner, author, and operator.
- [ ] Add billing or access control if the platform becomes public.
- [ ] Add an author-facing scenario publishing and approval workflow beyond the automated artifact pipeline.
- [ ] Add hosted resource quotas and abuse prevention.
