# Scenario Authoring

Scenarios live under `lab-definitions/<scenario-slug>/`. Each scenario must include a `manifest.json` plus a starter workspace template that can be copied into a disposable learner session.

## Manifest Contract

The stable manifest version is `schemaVersion: 1`.

Required fields:

- `slug`: stable unique ID, matching the `lab-definitions/<slug>` folder.
- `title`: learner-facing scenario title.
- `summary`: one-sentence catalog description.
- `domainTitle`: catalog group title.
- `domainSummary`: catalog group description.
- `displayOrder`: numeric sort order across catalog groups and scenarios.
- `scenarioLabel`: short card label, such as `One-change smoke test`.
- `difficulty.level`: numeric difficulty, starting at `1`.
- `difficulty.label`: learner-facing difficulty label, such as `Easy`.
- `tags`: searchable scenario tags.
- `status`: `draft`, `active`, or `archived`.
- `workspaceTemplate`: path from the scenario folder to the learner starter workspace.
- `previewCommand`: command used by the platform to start the app preview.
- `validationCommand`: command used by the platform to run learner checks.
- `expectedCommands`: author-facing install, dev, validate, lint, and build commands.
- `expectedPorts`: named container ports exposed by the starter.
- `ttlSeconds`: default local session lifetime.
- `authoring.readme`: path from the scenario folder to learner instructions.
- `authoring.checklist`: path from the scenario folder to the validation checklist.
- `authoring.tests`: test files that enforce the scenario outcome.
- `authoring.solutionPolicy`: one of `committed-solution-template`, `inline-simple`, `external-reference`, or `none`.

Optional fields:

- `solutionTemplate`: path from the scenario folder to a known-good solution workspace. Commit this for multi-file or behavior-heavy scenarios. Simple one-line scenarios can use `inline-simple` and describe the expected edit in the README.

## Starter Workspace Rules

Each starter workspace must include:

- `README.md` with the task, exact acceptance criteria, and any allowed hints.
- `CHECKLIST.md` with the learner-visible checks in plain language.
- `package.json` scripts for `dev`, `build`, `lint`, and `test`.
- At least one test listed in `authoring.tests`.
- A lockfile that supports `npm ci`.

The required command expectations are intentionally explicit. The local runner currently installs with `npm ci`, starts preview with the platform-managed Vite port, and runs `validationCommand` when the learner clicks `Run checks`.

## Import Workflow

Run this after creating or editing scenario manifests:

```bash
npm run scenarios:import
```

The script validates every manifest under `lab-definitions/` and regenerates `convex/scenarioSeedData.ts`. The dashboard `Seed scenarios` action imports that generated data into Convex.

To validate without intending to change source data, run:

```bash
npm run scenarios:check
```

The check command uses the same validator and fails if the generated file is stale.

## Smoke Test Workflow

Run this before marking a new scenario ready:

```bash
npm run scenarios:smoke
```

To smoke test one scenario:

```bash
npm run scenarios:smoke -- --scenario react-button-label
```

The smoke command copies each starter template to a temporary workspace, runs `expectedCommands.install`, confirms `validationCommand` fails before the solution is applied, overlays `solutionTemplate`, and confirms `validationCommand` passes.
