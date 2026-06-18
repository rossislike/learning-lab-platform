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

The frontend reads two product-readiness environment variables:

- `VITE_PRODUCT_SURFACE`: `local`, `hosted`, or `public`.
- `VITE_AUTH_MODE`: `disabled` or `configured`.

When `VITE_PRODUCT_SURFACE` is `hosted` or `public`, the app blocks startup unless `VITE_AUTH_MODE=configured`. This keeps hosted/public deployment from exposing learner sessions, progress records, or workspace URLs before authentication is wired in.
