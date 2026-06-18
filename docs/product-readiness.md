# Product Readiness

This document captures product-surface decisions that must be settled before moving the local MVP toward a hosted learning product.

## Personas

### Learner

The learner is the primary product user. The learner owns the simple controls that affect their own exercise.

The learner needs to:

- Browse exercises.
- Read task instructions and acceptance criteria.
- Edit code in the workspace.
- Run checks when ready.
- See validation feedback in learner-friendly language.
- Stop or exit the exercise at any time.
- Reopen current or recent progress where allowed by retention policy.

The learner should not need to understand runner health, cleanup internals, session queues, or workspace provisioning in the normal product flow.

### Operator

The operator role owns support and platform operations. Most operator responsibilities should become platform automation, not a required learner workflow.

The platform should automatically handle:

- Polling or dispatching runner work.
- Cleaning up stopped, expired, or unhealthy workspaces.
- Preserving durable progress records after disposable session cleanup.
- Applying retention and cost-control policies.

Operator-only surfaces are useful for development, support, and hosted operations.

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

Authoring remains a separate workflow from the learner exercise experience.
