// Loads and validates the scenario catalog under scenarios/:
//
//   scenarios/<area>/area.json
//   scenarios/<area>/<scenario>/manifest.json   (schemaVersion 2)
//
// Shared by the importer and the smoke test. Validation is schema-first
// (scenarios/manifest.schema.json, scenarios/area.schema.json) followed by
// the cross-checks the schema cannot express.

import { access, readdir, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatSchemaErrors, validateAgainstSchema } from "./json-schema.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const projectRoot = resolve(__dirname, "..");
export const scenariosRoot = resolve(projectRoot, "scenarios");

const DIFFICULTY_LEVELS = { easy: 1, medium: 2, hard: 3 };
const DEFAULT_TABS = { terminal: ["terminal"], react: ["terminal", "editor", "preview"] };
const REACT_REQUIRED_PACKAGE_SCRIPTS = ["dev", "test"];

export class CatalogError extends Error {}

function fail(message) {
  throw new CatalogError(`[scenario-catalog] ${message}`);
}

async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail(`${relative(projectRoot, path)} is not valid JSON: ${error.message}`);
  }
}

async function loadSchema(name) {
  return readJson(resolve(scenariosRoot, name));
}

function assertSchema(schema, value, label) {
  const errors = validateAgainstSchema(schema, value);
  if (errors.length > 0) fail(`${label} is invalid:\n${formatSchemaErrors(errors)}`);
}

async function requireFile(scenarioDir, relativePath, label, display) {
  const absolute = resolve(scenarioDir, relativePath);
  if (relative(scenarioDir, absolute).startsWith("..")) {
    fail(`${display} ${label} must stay inside the scenario directory: ${relativePath}`);
  }
  if (!(await pathExists(absolute))) {
    fail(`${display} references missing ${label}: ${relativePath}`);
  }
  const metadata = await stat(absolute);
  if (!metadata.isFile()) fail(`${display} ${label} is not a file: ${relativePath}`);
  return absolute;
}

async function loadMarkdown(scenarioDir, relativePath, label, display) {
  const absolute = await requireFile(scenarioDir, relativePath, label, display);
  const content = await readFile(absolute, "utf8");
  if (content.trim().length === 0) fail(`${display} ${label} is empty: ${relativePath}`);
  return content;
}

async function validateReactWorkspace(scenarioDir, display) {
  const workspaceDir = resolve(scenarioDir, "workspace");
  if (!(await pathExists(workspaceDir))) {
    fail(`${display} is a react scenario but has no workspace/ directory`);
  }
  const packagePath = resolve(workspaceDir, "package.json");
  if (!(await pathExists(packagePath))) {
    fail(`${display} workspace/ must contain package.json`);
  }
  const packageJson = await readJson(packagePath);
  for (const scriptName of REACT_REQUIRED_PACKAGE_SCRIPTS) {
    if (typeof packageJson.scripts?.[scriptName] !== "string") {
      fail(`${display} workspace/package.json must define scripts.${scriptName}`);
    }
  }
}

export async function loadScenario(manifestPath, { manifestSchema, areaSlug } = {}) {
  manifestSchema ??= await loadSchema("manifest.schema.json");
  const scenarioDir = dirname(manifestPath);
  const display = relative(projectRoot, manifestPath);
  const manifest = await readJson(manifestPath);
  assertSchema(manifestSchema, manifest, display);

  if (areaSlug !== undefined && manifest.area !== areaSlug) {
    fail(`${display} declares area "${manifest.area}" but lives under scenarios/${areaSlug}/`);
  }
  if (manifest.kind === "react" && !manifest.react) {
    fail(`${display} has kind "react" and must define the react block`);
  }
  if (manifest.kind !== "react" && manifest.react) {
    fail(`${display} has kind "${manifest.kind}" and must not define the react block`);
  }
  const tabs = manifest.tabs ?? DEFAULT_TABS[manifest.kind];
  if (manifest.kind !== "react" && tabs.some((tab) => tab !== "terminal")) {
    fail(`${display} terminal scenarios may only use the terminal tab`);
  }

  const intro = await loadMarkdown(scenarioDir, manifest.intro, "intro", display);
  const finish = await loadMarkdown(scenarioDir, manifest.finish, "finish", display);
  if (manifest.setup) await requireFile(scenarioDir, manifest.setup, "setup script", display);

  const steps = [];
  const seenContent = new Set();
  for (const [index, step] of manifest.steps.entries()) {
    const label = `steps[${index}]`;
    if (seenContent.has(step.content)) fail(`${display} ${label} reuses ${step.content}`);
    seenContent.add(step.content);
    const content = await loadMarkdown(scenarioDir, step.content, `${label}.content`, display);
    for (const key of ["setup", "verify", "solve"]) {
      if (step[key]) await requireFile(scenarioDir, step[key], `${label}.${key}`, display);
    }
    steps.push({
      title: step.title,
      content,
      ...(step.setup ? { setup: step.setup } : {}),
      ...(step.verify ? { verify: step.verify } : {}),
      ...(step.solve ? { solve: step.solve } : {}),
    });
  }

  if (manifest.kind === "react") await validateReactWorkspace(scenarioDir, display);

  return {
    manifest,
    manifestPath,
    scenarioDir,
    tabs,
    intro,
    finish,
    steps,
    difficultyLevel: DIFFICULTY_LEVELS[manifest.difficulty],
  };
}

export async function loadCatalog(root = scenariosRoot) {
  const manifestSchema = await loadSchema("manifest.schema.json");
  const areaSchema = await loadSchema("area.schema.json");
  const areas = [];
  const scenarios = [];
  const slugs = new Map();

  const areaEntries = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const areaEntry of areaEntries) {
    const areaDir = resolve(root, areaEntry.name);
    const areaPath = resolve(areaDir, "area.json");
    if (!(await pathExists(areaPath))) {
      fail(`scenarios/${areaEntry.name}/ has no area.json`);
    }
    const area = await readJson(areaPath);
    assertSchema(areaSchema, area, relative(projectRoot, areaPath));
    if (area.slug !== areaEntry.name) {
      fail(`${relative(projectRoot, areaPath)} slug "${area.slug}" must match its directory name`);
    }
    areas.push(area);

    const scenarioEntries = (await readdir(areaDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const scenarioEntry of scenarioEntries) {
      const manifestPath = resolve(areaDir, scenarioEntry.name, "manifest.json");
      if (!(await pathExists(manifestPath))) {
        fail(`scenarios/${areaEntry.name}/${scenarioEntry.name}/ has no manifest.json`);
      }
      const scenario = await loadScenario(manifestPath, { manifestSchema, areaSlug: area.slug });
      const { slug, displayOrder } = scenario.manifest;
      const display = relative(projectRoot, manifestPath);
      // Playground rule, both directions: the `playground/` directory holds
      // exactly the scenario whose slug is `<area>-playground` (slugs are
      // global, so the area prefix keeps them unique), and that slug may only
      // live in `playground/`. Every other scenario's slug is its directory
      // name. displayOrder 0 is reserved for playgrounds.
      const playgroundSlug = `${area.slug}-playground`;
      const isPlaygroundDir = scenarioEntry.name === "playground";
      const isPlaygroundSlug = slug === playgroundSlug;
      if (isPlaygroundDir && !isPlaygroundSlug) {
        fail(`${display} lives in playground/ so its slug must be "${playgroundSlug}" (got "${slug}")`);
      }
      if (!isPlaygroundDir && isPlaygroundSlug) {
        fail(`${display} slug "${slug}" is the area playground and must live in scenarios/${area.slug}/playground/`);
      }
      if (!isPlaygroundDir && scenarioEntry.name !== slug) {
        fail(`${display} slug "${slug}" must match its directory name`);
      }
      if (isPlaygroundDir && scenario.steps.length !== 0) {
        fail(`${display} is a playground and must not define steps`);
      }
      if (isPlaygroundDir && displayOrder !== 0) {
        fail(`${display} is a playground and must use displayOrder 0`);
      }
      if (!isPlaygroundDir && displayOrder === 0) {
        fail(`${display} displayOrder 0 is reserved for the area playground`);
      }
      if (slugs.has(slug)) {
        fail(`duplicate scenario slug "${slug}" in ${slugs.get(slug)} and ${relative(projectRoot, manifestPath)}`);
      }
      slugs.set(slug, relative(projectRoot, manifestPath));
      scenarios.push(scenario);
    }
  }

  areas.sort((a, b) => a.displayOrder - b.displayOrder || a.slug.localeCompare(b.slug));
  scenarios.sort(
    (a, b) =>
      a.manifest.area.localeCompare(b.manifest.area) ||
      a.manifest.displayOrder - b.manifest.displayOrder ||
      a.manifest.slug.localeCompare(b.manifest.slug),
  );
  return { areas, scenarios };
}

/** Shape stored in Convex (and written to convex/scenarioSeedData.ts). */
export function toSeedRecord(scenario, areasBySlug) {
  const { manifest } = scenario;
  const area = areasBySlug.get(manifest.area);
  const record = {
    manifestVersion: 2,
    slug: manifest.slug,
    area: manifest.area,
    kind: manifest.kind,
    title: manifest.title,
    summary: manifest.summary,
    difficulty: scenario.difficultyLevel,
    difficultyLabel: manifest.difficulty,
    tags: manifest.tags,
    status: manifest.status,
    displayOrder: manifest.displayOrder,
    ttlSeconds: manifest.ttlSeconds,
    tabs: scenario.tabs,
    workspace: manifest.workspace,
    ...(manifest.setup ? { setup: manifest.setup } : {}),
    intro: scenario.intro,
    finish: scenario.finish,
    steps: scenario.steps.map((step) => {
      const learnerStep = { ...step };
      delete learnerStep.solve;
      return learnerStep;
    }),
    // Compatibility with the current dashboard grouping (removed in Phase 4).
    domainTitle: area.title,
    domainSummary: area.summary,
    scenarioLabel: manifest.kind === "react" ? "React scenario" : "Terminal scenario",
  };
  if (manifest.kind === "react") {
    record.react = manifest.react;
    // Legacy local Docker runner inputs (removed in Phase 3).
    record.templatePath = relative(projectRoot, resolve(scenario.scenarioDir, "workspace"));
    record.previewCommand = manifest.react.devCommand;
    // Scenarios without a verify step (playgrounds) ship no tests, and vitest
    // exits 1 when it finds none; --passWithNoTests keeps the legacy Check
    // button green there.
    const hasVerify = scenario.steps.some((step) => step.verify);
    record.validationCommand = `${manifest.react.testCommand}${hasVerify ? "" : " --passWithNoTests"} --reporter=json`;
  }
  return record;
}
