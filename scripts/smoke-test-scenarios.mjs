import { spawn } from "node:child_process";
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const labDefinitionsRoot = resolve(projectRoot, "lab-definitions");

function fail(message) {
  throw new Error(`[scenario-smoke] ${message}`);
}

function run(command, cwd) {
  return new Promise((resolveRun) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      resolveRun({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function loadManifests() {
  const entries = await readdir(labDefinitionsRoot, { withFileTypes: true });
  const manifests = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = resolve(labDefinitionsRoot, entry.name, "manifest.json");
    const manifest = await readJson(manifestPath);
    manifests.push({ manifest, manifestPath, labRoot: dirname(manifestPath) });
  }

  return manifests.sort(
    (a, b) =>
      a.manifest.displayOrder - b.manifest.displayOrder ||
      a.manifest.slug.localeCompare(b.manifest.slug)
  );
}

function parseArgs(args) {
  const options = {
    keepWorkspaces: false,
    scenarioSlugs: [],
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--keep") {
      options.keepWorkspaces = true;
    } else if (arg === "--scenario") {
      const slug = args[index + 1];
      if (!slug) fail("--scenario requires a slug");
      options.scenarioSlugs.push(slug);
      index += 1;
    } else {
      fail(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function templateFilter(path) {
  return (
    !path.includes("/node_modules/") &&
    !path.endsWith("/node_modules") &&
    !path.includes("/dist/") &&
    !path.endsWith("/dist")
  );
}

async function copyTemplate(source, target) {
  await cp(source, target, {
    recursive: true,
    force: true,
    filter: templateFilter,
  });
}

function formatOutput(result) {
  return [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
}

async function smokeScenario({ manifest, labRoot }, options) {
  if (!manifest.solutionTemplate) {
    fail(`${manifest.slug} must define solutionTemplate for smoke testing`);
  }

  const workspacePath = await mkdtemp(resolve(tmpdir(), `llp-${manifest.slug}-`));
  const starterPath = resolve(labRoot, manifest.workspaceTemplate);
  const solutionPath = resolve(labRoot, manifest.solutionTemplate);
  const installCommand = manifest.expectedCommands?.install ?? "npm ci";

  try {
    await copyTemplate(starterPath, workspacePath);
    console.log(`[scenario-smoke] ${manifest.slug}: copied starter`);

    const install = await run(installCommand, workspacePath);
    if (install.code !== 0) {
      fail(
        `${manifest.slug} install failed in ${workspacePath}\n${formatOutput(install)}`
      );
    }
    console.log(`[scenario-smoke] ${manifest.slug}: installed dependencies`);

    const failingCheck = await run(manifest.validationCommand, workspacePath);
    if (failingCheck.code === 0) {
      fail(`${manifest.slug} starter validation unexpectedly passed`);
    }
    console.log(`[scenario-smoke] ${manifest.slug}: starter check failed as expected`);

    await copyTemplate(solutionPath, workspacePath);
    console.log(`[scenario-smoke] ${manifest.slug}: applied solution`);

    const passingCheck = await run(manifest.validationCommand, workspacePath);
    if (passingCheck.code !== 0) {
      fail(
        `${manifest.slug} solution validation failed in ${workspacePath}\n${formatOutput(passingCheck)}`
      );
    }
    console.log(`[scenario-smoke] ${manifest.slug}: solution check passed`);
  } finally {
    if (options.keepWorkspaces) {
      console.log(
        `[scenario-smoke] ${manifest.slug}: kept ${relative(projectRoot, workspacePath)}`
      );
    } else {
      await rm(workspacePath, { recursive: true, force: true });
    }
  }
}

const options = parseArgs(process.argv.slice(2));
const manifests = await loadManifests();
const selected =
  options.scenarioSlugs.length === 0
    ? manifests
    : manifests.filter(({ manifest }) => options.scenarioSlugs.includes(manifest.slug));

for (const slug of options.scenarioSlugs) {
  if (!selected.some(({ manifest }) => manifest.slug === slug)) {
    fail(`Unknown scenario slug: ${slug}`);
  }
}

for (const scenario of selected) {
  await smokeScenario(scenario, options);
}

console.log(`[scenario-smoke] completed ${selected.length} scenario(s)`);
