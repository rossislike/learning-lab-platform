# ADR 0006: Scenario Manifest v2 And Step Model

- Status: Accepted
- Date: 2026-10-22
- Decision owners: Learning Lab Platform maintainers

## Context

Manifest v1 (`lab-definitions/<slug>/manifest.json`) describes exactly one
kind of scenario: a Vite project opened in OpenVSCode with a single
`validationCommand`. The target experience is step-based: an intro, N steps
each with its own instructions and verification, a finish page, and a
`START` / `BACK` / `NEXT` flow.

## Decision

Introduce manifest **schemaVersion 2**, stored under
`scenarios/<area>/<slug>/`:

```
manifest.json      # metadata, kind, steps[]
intro.md           # shown before START
step1.md … stepN.md
finish.md          # shown after the last verified step
scripts/
  setup.sh         # runs in the background as soon as the pod is ready (optional)
  stepN-setup.sh   # per-step setup (optional)
  stepN-verify.sh  # exit 0 = pass; stdout is shown on failure
  stepN-solve.sh   # applies the solution; smoke test only, never bundled
workspace/         # react kind only: project copied to /workspace
solution/          # optional; used by solve scripts, never bundled
```

Key fields:

- `area` — catalog grouping (`linux`, `git`, `node`, `react`, …).
- `kind` — `terminal` or `react`. `react` adds `editor` and `preview` tabs
  and a `react` block (`previewPort`, `installCommand`, `devCommand`,
  `testCommand`).
- `steps[]` — ordered `{ title, content, setup?, verify?, solve? }`. A
  scenario with zero steps is a playground.
- `setup` runs once in the background: the session is `running` as soon as
  the terminal is usable, before the intro is shown; the shell shows setup
  status until it passes and the preview appears when it is ready. `START`
  only moves the step pointer to step 1.
- `workspace` — `{ cwd, user }`; `user` is `learner` or `root` (in-container
  only, see ADR 0005).
- `ttlSeconds`, `difficulty`, `tags`, `status`.

Markdown is rendered by the instruction pane. Fenced code blocks gain a
"run in terminal" affordance; `<details>` blocks render as collapsible
Hint/Solution panels.

Convex stores the manifest's `steps` on the scenario, `currentStep` on the
session, and a `sessionSteps` row per attempted step (status, output,
verifiedAt). Progress records gain `completedSteps`.

Scenario bundles remain digest-addressed tarballs published to S3 and
approved in Convex for the `dev` environment; locally the bundle is mounted
from the repository.

## Consequences

- The four existing React labs are converted to v2 with 2–4 steps each.
- `scripts/import-scenarios.mjs` and the smoke test are rewritten for v2 and
  validate manifests against a JSON schema.
- Manifest v1 and `lab-definitions/` are removed once conversion is complete
  (Phase 1).
