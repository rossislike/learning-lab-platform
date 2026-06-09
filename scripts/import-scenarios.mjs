import { access, readdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const labDefinitionsRoot = resolve(projectRoot, "lab-definitions");
const outputPath = resolve(projectRoot, "convex/scenarioSeedData.ts");
const requiredPackageScripts = ["dev", "build", "lint", "test"];
const requiredExpectedCommands = ["install", "dev", "validate", "lint", "build"];
const validStatuses = new Set(["draft", "active", "archived"]);
const validSolutionPolicies = new Set([
  "committed-solution-template",
  "inline-simple",
  "external-reference",
  "none",
]);

function fail(message) {
  throw new Error(`[scenario-import] ${message}`);
}

async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function assertString(value, field, manifestPath) {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${relative(projectRoot, manifestPath)} must define non-empty ${field}`);
  }
}

function assertNumber(value, field, manifestPath) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${relative(projectRoot, manifestPath)} must define numeric ${field}`);
  }
}

async function loadManifestPaths(args) {
  if (args.length > 0) {
    return args.map((arg) => resolve(projectRoot, arg));
  }

  const entries = await readdir(labDefinitionsRoot, { withFileTypes: true });
  const manifests = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = resolve(labDefinitionsRoot, entry.name, "manifest.json");
    if (await pathExists(manifestPath)) {
      manifests.push(manifestPath);
    }
  }

  return manifests.sort();
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail(`${relative(projectRoot, path)} is not valid JSON: ${error.message}`);
  }
}

async function validateStarter(manifest, manifestPath, labRoot) {
  const templatePath = resolve(labRoot, manifest.workspaceTemplate);
  const packagePath = resolve(templatePath, "package.json");
  const readmePath = resolve(labRoot, manifest.authoring.readme);
  const checklistPath = resolve(labRoot, manifest.authoring.checklist);

  for (const [label, path] of [
    ["workspaceTemplate", templatePath],
    ["README", readmePath],
    ["CHECKLIST", checklistPath],
    ["package.json", packagePath],
  ]) {
    if (!(await pathExists(path))) {
      fail(`${relative(projectRoot, manifestPath)} references missing ${label}: ${relative(projectRoot, path)}`);
    }
  }

  for (const testPath of manifest.authoring.tests) {
    const resolvedTestPath = resolve(labRoot, testPath);
    if (!(await pathExists(resolvedTestPath))) {
      fail(`${relative(projectRoot, manifestPath)} references missing test: ${relative(projectRoot, resolvedTestPath)}`);
    }
  }

  const packageJson = await readJson(packagePath);
  for (const scriptName of requiredPackageScripts) {
    if (typeof packageJson.scripts?.[scriptName] !== "string") {
      fail(`${relative(projectRoot, packagePath)} must define scripts.${scriptName}`);
    }
  }
}

async function validateManifest(manifestPath) {
  const manifest = await readJson(manifestPath);
  const labRoot = dirname(manifestPath);

  if (manifest.schemaVersion !== 1) {
    fail(`${relative(projectRoot, manifestPath)} must set schemaVersion to 1`);
  }

  for (const field of [
    "slug",
    "title",
    "summary",
    "domainTitle",
    "domainSummary",
    "scenarioLabel",
    "workspaceTemplate",
    "previewCommand",
    "validationCommand",
    "remediationFile",
    "expectedBehavior",
  ]) {
    assertString(manifest[field], field, manifestPath);
  }

  assertNumber(manifest.displayOrder, "displayOrder", manifestPath);

  if (!validStatuses.has(manifest.status)) {
    fail(`${relative(projectRoot, manifestPath)} status must be draft, active, or archived`);
  }

  if (!Array.isArray(manifest.tags) || manifest.tags.length === 0) {
    fail(`${relative(projectRoot, manifestPath)} must define at least one tag`);
  }

  for (const tag of manifest.tags) {
    assertString(tag, "tags[]", manifestPath);
  }

  assertNumber(manifest.difficulty?.level, "difficulty.level", manifestPath);
  assertString(manifest.difficulty?.label, "difficulty.label", manifestPath);

  if (!manifest.expectedCommands || typeof manifest.expectedCommands !== "object") {
    fail(`${relative(projectRoot, manifestPath)} must define expectedCommands`);
  }

  for (const commandName of requiredExpectedCommands) {
    assertString(
      manifest.expectedCommands[commandName],
      `expectedCommands.${commandName}`,
      manifestPath
    );
  }

  if (!Array.isArray(manifest.expectedPorts) || manifest.expectedPorts.length === 0) {
    fail(`${relative(projectRoot, manifestPath)} must define at least one expected port`);
  }

  for (const port of manifest.expectedPorts) {
    assertString(port.name, "expectedPorts[].name", manifestPath);
    assertNumber(port.containerPort, "expectedPorts[].containerPort", manifestPath);
    if (typeof port.public !== "boolean") {
      fail(`${relative(projectRoot, manifestPath)} expectedPorts[].public must be boolean`);
    }
  }

  assertNumber(manifest.ttlSeconds, "ttlSeconds", manifestPath);

  if (!manifest.authoring || typeof manifest.authoring !== "object") {
    fail(`${relative(projectRoot, manifestPath)} must define authoring metadata`);
  }

  assertString(manifest.authoring.readme, "authoring.readme", manifestPath);
  assertString(manifest.authoring.checklist, "authoring.checklist", manifestPath);

  if (!Array.isArray(manifest.authoring.tests) || manifest.authoring.tests.length === 0) {
    fail(`${relative(projectRoot, manifestPath)} must define authoring.tests`);
  }

  if (!validSolutionPolicies.has(manifest.authoring.solutionPolicy)) {
    fail(
      `${relative(projectRoot, manifestPath)} authoring.solutionPolicy must be one of ${[
        ...validSolutionPolicies,
      ].join(", ")}`
    );
  }

  if (manifest.solutionTemplate) {
    const solutionPath = resolve(labRoot, manifest.solutionTemplate);
    if (!(await pathExists(solutionPath))) {
      fail(`${relative(projectRoot, manifestPath)} references missing solutionTemplate: ${relative(projectRoot, solutionPath)}`);
    }
  }

  await validateStarter(manifest, manifestPath, labRoot);

  return {
    slug: manifest.slug,
    title: manifest.title,
    summary: manifest.summary,
    domainTitle: manifest.domainTitle,
    domainSummary: manifest.domainSummary,
    displayOrder: manifest.displayOrder,
    scenarioLabel: manifest.scenarioLabel,
    difficulty: manifest.difficulty.level,
    tags: manifest.tags,
    templatePath: relative(projectRoot, resolve(labRoot, manifest.workspaceTemplate)),
    validationCommand: manifest.validationCommand,
    previewCommand: manifest.previewCommand,
    remediationFile: manifest.remediationFile,
    expectedBehavior: manifest.expectedBehavior,
    status: manifest.status,
  };
}

function renderSeedData(scenarios) {
  return [
    "// Generated by `npm run scenarios:import`. Do not edit by hand.",
    "",
    `export const scenarioSeedData = ${JSON.stringify(scenarios, null, 2)} as const;`,
    "",
  ].join("\n");
}

const cliArgs = process.argv.slice(2);
const checkOnly = cliArgs.includes("--check");
const manifestArgs = cliArgs.filter((arg) => arg !== "--check");
const manifestPaths = await loadManifestPaths(manifestArgs);
const scenarios = [];
const slugs = new Set();

for (const manifestPath of manifestPaths) {
  const scenario = await validateManifest(manifestPath);
  if (slugs.has(scenario.slug)) {
    fail(`duplicate scenario slug: ${scenario.slug}`);
  }
  slugs.add(scenario.slug);
  scenarios.push(scenario);
}

scenarios.sort((a, b) => a.displayOrder - b.displayOrder || a.slug.localeCompare(b.slug));
const output = renderSeedData(scenarios);

if (checkOnly) {
  const existing = await readFile(outputPath, "utf8");
  if (existing !== output) {
    fail(`${relative(projectRoot, outputPath)} is out of date. Run npm run scenarios:import`);
  }
} else {
  await writeFile(outputPath, output);
}

for (const scenario of scenarios) {
  console.log(`[scenario-import] ${scenario.slug}`);
}
console.log(
  checkOnly
    ? `[scenario-import] checked ${relative(projectRoot, outputPath)}`
    : `[scenario-import] wrote ${relative(projectRoot, outputPath)}`
);
