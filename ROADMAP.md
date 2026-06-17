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
- [ ] Add attempt summaries per scenario.
- [ ] Add durable progress records separate from disposable sessions.

## Product Readiness

- [ ] Define learner, operator, and author personas.
- [ ] Decide whether the first product surface is single-learner, instructor-led, or self-serve.
- [ ] Add authentication before any hosted/public deployment.
- [ ] Add authorization boundaries around sessions and workspace URLs.
- [ ] Add a basic course/module structure above scenarios.
- [ ] Add observability for session startup time, validation time, failure rates, and resource cleanup.
- [ ] Add cost controls before running hosted workloads.

## AWS Migration

- [ ] Preserve the local runner interface while adding an AWS runner implementation.
- [ ] Decide the hosted execution model: ECS/Fargate first unless requirements force EKS/KubeVirt.
- [ ] Define workspace storage strategy for hosted sessions.
- [ ] Define routing for editor, preview, and tools URLs.
- [ ] Add secure per-session URL access.
- [ ] Implement hosted TTL cleanup.
- [ ] Add infrastructure as code under `infra/`.
- [ ] Validate one hosted React scenario end to end.

## Later Multi-User Platform

- [ ] Add user accounts.
- [ ] Add organizations or teams.
- [ ] Add course enrollment and learner progress.
- [ ] Add role-based access for learner, author, and operator.
- [ ] Add billing or access control if the platform becomes public.
- [ ] Add scenario publishing workflow.
- [ ] Add hosted resource quotas and abuse prevention.
