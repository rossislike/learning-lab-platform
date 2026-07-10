# Product Readiness

This document captures product-surface decisions that must be settled before moving the local MVP toward a hosted learning product.

## First Product Surface

The first product surface is self-serve.

The default flow should be:

1. The learner opens the product.
2. The learner selects an exercise.
3. The platform automatically starts everything needed for that exercise:
   - session record
   - disposable workspace
   - editor
   - preview
   - tools/check server
   - progress record
4. The learner works in the exercise.
5. The learner runs checks when ready.
6. The learner can exit or stop the exercise at any time.

The product should not require a separate operator action to request, start, or prepare an exercise for normal learner use.

## Personas

### Learner

The learner is the primary product user. In the first product surface, the learner owns the simple operational controls that affect their own exercise.

The learner needs to:

- Browse and start exercises.
- Have the workspace, preview, and tools start automatically after choosing an exercise.
- Read task instructions and acceptance criteria.
- Edit code in the workspace.
- Run checks when ready.
- See validation feedback in learner-friendly language.
- Stop or exit the exercise at any time.
- Reopen current or recent progress where allowed by retention policy.

The learner should not need to understand runner health, cleanup internals, session queues, or workspace provisioning in the normal product flow.

### Operator

The operator role is minimized for the first product surface. Most operator responsibilities should become platform automation, not a separate user workflow.

The platform should automatically handle:

- Starting sessions after learner exercise selection.
- Polling or dispatching runner work.
- Cleaning up stopped, expired, or unhealthy workspaces.
- Preserving durable progress records after disposable session cleanup.
- Applying retention and cost-control policies.

Operator-only surfaces are still useful for development, support, and hosted operations, but they should not be required for a learner to complete an exercise.

### Author

The author creates and maintains exercise content.

The author needs to:

- Write scenario manifests.
- Provide starter workspace templates.
- Define learner instructions and checklist items.
- Define validation commands and tests.
- Provide solution templates when needed.
- Import and smoke-test scenarios before publishing.
- Keep scenario metadata clear enough for learners and debuggable enough for support.

Authoring remains a separate workflow from the learner self-serve experience.

## Product Implications

- The dashboard should evolve away from operator-first session request controls toward learner-first exercise start controls.
- Starting an exercise should request the session and guide the learner into the workspace automatically.
- Stop and exit controls should stay available in the learner workspace.
- Runner health and detailed cleanup controls should move toward support/admin visibility.
- Authentication and authorization should model the learner as the owner of their exercise sessions and progress records.

## Authentication Gate

Local development can run with authentication disabled. Hosted or public deployment cannot.

The frontend reads these product-readiness environment variables:

- `VITE_PRODUCT_SURFACE`: `local`, `hosted`, or `public`.
- `VITE_AUTH_MODE`: `disabled` or `configured`.
- `VITE_SESSION_ACCESS_MODE`: `local-only` or `authorized`.
- `VITE_COST_CONTROLS_MODE`: `local-limits` or `enforced`.

When `VITE_PRODUCT_SURFACE` is `hosted` or `public`, the app blocks startup unless `VITE_AUTH_MODE=configured`. This keeps hosted/public deployment from exposing learner sessions, progress records, or workspace URLs before authentication is wired in.

## Authorization Boundary

Local development can expose local session and workspace URLs to the local operator. Hosted or public deployment must not.

When `VITE_PRODUCT_SURFACE` is `hosted` or `public`, the app also blocks startup unless `VITE_SESSION_ACCESS_MODE=authorized`. This makes the hosted launch contract explicit: session data, progress records, editor URLs, preview URLs, and tools URLs must be scoped to the authenticated learner or an authorized support/admin role before the hosted product can run.

The current local MVP does not implement a full identity provider or hosted gateway. Hosted per-session access is defined in [ADR 0004](decisions/0004-secure-session-access.md) and uses authenticated ownership, endpoint-bound one-time POST bootstrap codes, host-only `HttpOnly` cookies, gateway authorization, and bounded revocation. Hosted/public mode remains gated until that complete boundary is deployed.

## Course And Module Structure

Scenarios now sit under a basic course/module hierarchy:

- `courses`: top-level learning products, starting with `React Labs`.
- `courseModules`: ordered groups inside a course, derived from scenario domain metadata.
- `labs`: individual scenarios linked to a course and module.

The scenario seeding workflow creates or updates the default React course and module records before upserting scenarios. This gives the self-serve product a durable structure above individual exercises without introducing enrollment yet.

## Observability

Sessions now record operational timing fields:

- `startupDurationMs`: time from session request to runner-ready state.
- `lastValidationDurationMs`: time from check start to check completion.
- `cleanupDurationMs`: time from cleanup request or stop/expiry to cleaned state.

The dashboard runner panel reads a Convex observability summary for recent sessions and shows average startup time, average validation time, failure rate, and average cleanup time. These metrics give the hosted product a basic signal for runner health, learner friction, validation latency, and cleanup reliability.

## Cost Controls

Local development has conservative session limits:

- Requested TTL is capped at 1 hour.
- Local runner sessions are capped at 5 active sessions across `requested`, `starting`, `running`, and `checking`.

Hosted or public mode is also gated by `VITE_COST_CONTROLS_MODE=enforced`. This prevents hosted workloads from starting until the deployment has explicit cost controls for session concurrency, TTL, cleanup, and hosted runner capacity.
