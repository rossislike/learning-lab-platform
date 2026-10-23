# Scenario authoring (manifest v2)

A scenario is a directory under `scenarios/<area>/<slug>/`. The catalog is the
directory tree: areas are `scenarios/<area>/area.json`, scenarios are the
subdirectories with a `manifest.json`. ADR 0006 records the design.

```
scenarios/
  manifest.schema.json         JSON Schema for manifest.json
  area.schema.json             JSON Schema for area.json
  git/
    area.json                  { slug, title, summary, displayOrder }
    playground/                zero-step scenario (one per area; slug git-playground)
    first-commit/
      manifest.json
      intro.md                 shown before START
      step1.md … stepN.md      one file per step
      finish.md                shown after the last step
      scripts/
        setup.sh               runs in the background once the pod is ready (optional)
        stepN-setup.sh         runs when step N opens (optional)
        stepN-verify.sh        exit 0 = pass; stdout is the learner's hint on failure
        stepN-solve.sh         applies the solution; smoke test only, never bundled
  react/
    welcome-message/
      …same files…
      workspace/               Vite project copied to workspace.cwd before setup
      solution/src/            files the solve script copies over the workspace
```

## manifest.json

```jsonc
{
  "schemaVersion": 2,
  "slug": "first-commit",            // unique across all areas; directory name (playgrounds: see below)
  "area": "git",                     // parent directory; must have area.json
  "kind": "terminal",                // "terminal" | "react"
  "title": "Your First Commit",
  "summary": "One sentence for the scenario card.",
  "difficulty": "easy",              // easy | medium | hard
  "tags": ["git", "fundamentals"],
  "status": "active",                // draft | active | archived
  "displayOrder": 10,                // 0 is reserved for, and required by, the area playground
  "ttlSeconds": 3600,                // 60 … 28800
  "tabs": ["terminal"],              // optional; react defaults to terminal, editor, preview; terminal kind may only list terminal
  "workspace": { "cwd": "/workspace", "user": "learner" },   // user: learner | root (in-container only)
  "setup": "scripts/setup.sh",       // optional; runs in the background as soon as the pod is ready
  "intro": "intro.md",
  "finish": "finish.md",
  "steps": [
    { "title": "Initialise a repository", "content": "step1.md",
      "verify": "scripts/step1-verify.sh", "solve": "scripts/step1-solve.sh" }
  ],
  "react": {                         // required for kind react, forbidden otherwise
    "previewPort": 5173,
    "installCommand": "npm ci --no-audit --no-fund",
    "devCommand": "npm run dev -- --host 0.0.0.0 --port 5173",
    "testCommand": "npm test -- --run"
  }
}
```

Steps without `verify` advance on **NEXT** unconditionally (good for "look
around" steps); they count as completed once the learner has moved past them.
A scenario with zero steps is a playground: **START** goes straight to
`finish.md` and the scenario counts as complete at that point.

Playgrounds follow one naming rule, enforced by the importer in both
directions: the directory is `scenarios/<area>/playground/`, the slug is
`<area>-playground` (slugs are global, so the area prefix keeps them unique),
`displayOrder` is `0`, and `steps` is empty. No other scenario may use that
slug or `displayOrder: 0`.

Terminal scenarios may only use the `terminal` tab; `editor` and `preview`
are for `kind: react`.

## Scripts

All scripts run with `bash`, with the working directory set to
`workspace.cwd`, as `workspace.user`, and with these variables:

| Variable | Value |
|---|---|
| `LAB_WORKSPACE` | `workspace.cwd` |
| `LAB_SCENARIO_DIR` | the scenario bundle root (`manifest.json` lives here) |
| `LAB_SCENARIO_SLUG` | the slug |
| `LAB_STEP` | 1-based step number (step scripts only) |

- `setup` (the scenario-level script) starts in the background as soon as
  the session pod is ready, before the intro is shown, so dependency
  installs overlap with the learner reading. **START** only moves the pointer
  to step 1; it does not wait for or re-run setup. The session agent exposes
  setup status (Phase 2) so the shell can show "preparing…" if the learner is
  quicker than the install.
- `verify` scripts exit `0` to pass. On failure, everything they print to
  **stdout** is shown to the learner under the step, so print one or two lines
  that say what is missing and which command fixes it.
- `solve` scripts exist only so the smoke test can prove each step. They are
  excluded from bundles, as is the top-level `solution/` directory, and the
  bundled `manifest.json` has `steps[].solve` stripped.
- For react scenarios, `setup.sh` normally runs the install command and
  `solve` copies `solution/src/` over `workspace/src/`.

## Markdown

Step files are plain Markdown. Fenced code blocks get a "run in terminal"
affordance in the scenario shell. Use `<details><summary>Hint</summary> …
</details>` for collapsible hints and solutions, as in the Killercoda
reference (`docs/2026-10-22/4.png`).

## Commands

```bash
npm run scenarios:import     # validate, write convex/scenarioSeedData.ts, build build/scenarios/*.tar
npm run scenarios:check      # validate and confirm the seed file is current (CI)
npm run scenarios:smoke      # prove every verify fails → solve → passes (Docker if available)
npm run scenarios:smoke -- --local --scenario first-commit   # on this machine, one scenario
npm run test:runner          # unit tests, including schema and bundle tests
```

The importer writes `convex/scenarioSeedData.ts`; commit it. The dashboard's
**Seed scenarios** button (`labs.seedScenarios`) upserts areas and scenarios
from that file and archives scenarios that are no longer in it.

## Checklist for a new scenario

1. Copy `scenarios/git/first-commit` as the template.
2. Write `intro.md`, the steps, and `finish.md`. Keep each step to one idea.
3. Write `stepN-verify.sh` first, then `stepN-solve.sh`, for every step that
   has a checkable outcome.
4. `npm run scenarios:import` — fix any schema errors it prints.
5. `npm run scenarios:smoke -- --scenario <slug>` — every verifiable step must
   report `fails→solve→passes`.
6. Commit the scenario directory and the regenerated seed file.
