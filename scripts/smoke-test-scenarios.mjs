// Scenario smoke test for manifest v2.
//
// For every selected scenario: prepare a throwaway workspace, run the setup
// script, then for each step run its setup, prove that `verify` FAILS on the
// untouched workspace, apply `solve`, and prove that `verify` PASSES.
//
// Runs inside a Docker container when `docker` is available — the
// session-workspace image if it has been built (`npm run image:build`),
// otherwise node:22-bookworm — or directly on this machine with --local
// (requires bash, git, node).
//
// Usage:
//   npm run scenarios:smoke                      all scenarios
//   npm run scenarios:smoke -- --scenario first-commit --scenario cli-tool
//   npm run scenarios:smoke -- --local --keep
//   SMOKE_IMAGE=learning-lab/session-workspace:dev npm run scenarios:smoke

import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { CatalogError, loadCatalog, projectRoot } from "./scenario-catalog.mjs";

const SESSION_IMAGE = "learning-lab/session-workspace:dev";
const FALLBACK_IMAGE = "node:22-bookworm";
const COMMAND_TIMEOUT_MS = Number(process.env.SMOKE_COMMAND_TIMEOUT_MS ?? 10 * 60 * 1000);
const CONTAINER_WORKSPACE = "/workspace";
const CONTAINER_SCENARIO = "/scenario";

function fail(message) {
  throw new Error(`[scenario-smoke] ${message}`);
}

function parseArgs(args) {
  const options = { keep: false, local: false, scenarioSlugs: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--keep") options.keep = true;
    else if (arg === "--local") options.local = true;
    else if (arg === "--scenario") {
      const slug = args[index + 1];
      if (!slug) fail("--scenario requires a slug");
      options.scenarioSlugs.push(slug);
      index += 1;
    } else fail(`Unknown argument: ${arg}`);
  }
  return options;
}

function exec(command, args, { cwd, env, input } = {}) {
  return new Promise((resolveExec) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, COMMAND_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    if (input !== undefined) child.stdin.end(input);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveExec({ code: code ?? 1, stdout, stderr, timedOut });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveExec({ code: 1, stdout, stderr: `${stderr}${error.message}`, timedOut });
    });
  });
}

/**
 * A timed-out script is never a "correct" failure: a verify that hangs
 * would otherwise be reported as "fails before solve" and pass the smoke
 * test. Every script result goes through here first.
 */
function assertNotTimedOut(result, what) {
  if (result.timedOut) {
    fail(`${what} timed out after ${COMMAND_TIMEOUT_MS} ms and was killed\n${output(result)}`);
  }
  return result;
}

function output(result) {
  return [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
}

async function dockerAvailable() {
  const result = await exec("docker", ["version", "--format", "{{.Server.Version}}"]);
  return result.code === 0;
}

/** Prefer the real session image when it exists locally. */
async function resolveImage() {
  if (process.env.SMOKE_IMAGE) return process.env.SMOKE_IMAGE;
  const inspect = await exec("docker", ["image", "inspect", SESSION_IMAGE]);
  return inspect.code === 0 ? SESSION_IMAGE : FALLBACK_IMAGE;
}

/** Executes scenario scripts directly on this machine in a temp workspace. */
class LocalRunner {
  constructor(scenario, keep) {
    this.scenario = scenario;
    this.keep = keep;
  }
  async start() {
    this.root = await mkdtemp(resolve(tmpdir(), `llp-smoke-${this.scenario.manifest.slug}-`));
    this.workspace = resolve(this.root, "workspace");
    this.home = resolve(this.root, "home");
    await mkdir(this.workspace, { recursive: true });
    await mkdir(this.home, { recursive: true });
    this.env = {
      HOME: this.home,
      LAB_WORKSPACE: this.workspace,
      LAB_SCENARIO_DIR: this.scenario.scenarioDir,
      LAB_SCENARIO_SLUG: this.scenario.manifest.slug,
    };
  }
  async prepareReactWorkspace() {
    await cp(resolve(this.scenario.scenarioDir, "workspace"), this.workspace, {
      recursive: true,
      filter: (source) => !/\/(node_modules|dist)(\/|$)/.test(source),
    });
  }
  run(script, extraEnv = {}) {
    return exec("bash", [resolve(this.scenario.scenarioDir, script)], {
      cwd: this.workspace,
      env: { ...this.env, ...extraEnv },
    });
  }
  async stop() {
    if (!this.root) return; // start() failed before creating the temp dir
    if (this.keep) console.log(`[scenario-smoke] kept ${this.root}`);
    else await rm(this.root, { recursive: true, force: true });
  }
  describe() {
    return `local (${relative(projectRoot, this.workspace) || this.workspace})`;
  }
}

/** Executes scenario scripts inside a throwaway Docker container. */
class DockerRunner {
  constructor(scenario, keep, image) {
    this.scenario = scenario;
    this.keep = keep;
    this.image = image;
    this.name = `llp-smoke-${scenario.manifest.slug}-${process.pid}`;
  }
  async start() {
    const result = await exec("docker", [
      "run", "-d", "--rm", "--name", this.name,
      "-v", `${this.scenario.scenarioDir}:${CONTAINER_SCENARIO}:ro`,
      "-w", CONTAINER_WORKSPACE,
      this.image, "sleep", "infinity",
    ]);
    if (result.code !== 0) fail(`docker run failed for ${this.scenario.manifest.slug}\n${output(result)}`);
    const prepare = await this.exec(["bash", "-c", `mkdir -p ${CONTAINER_WORKSPACE} && git --version && node --version`]);
    if (prepare.code !== 0) fail(`container is missing git or node\n${output(prepare)}`);
  }
  async prepareReactWorkspace() {
    const result = await this.exec(["bash", "-c", `cp -R ${CONTAINER_SCENARIO}/workspace/. ${CONTAINER_WORKSPACE}/`]);
    if (result.code !== 0) fail(`copying workspace/ failed\n${output(result)}`);
  }
  exec(args, extraEnv = {}) {
    const envArgs = Object.entries({
      LAB_WORKSPACE: CONTAINER_WORKSPACE,
      LAB_SCENARIO_DIR: CONTAINER_SCENARIO,
      LAB_SCENARIO_SLUG: this.scenario.manifest.slug,
      ...extraEnv,
    }).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
    return exec("docker", ["exec", "-w", CONTAINER_WORKSPACE, ...envArgs, this.name, ...args]);
  }
  run(script, extraEnv = {}) {
    return this.exec(["bash", `${CONTAINER_SCENARIO}/${script}`], extraEnv);
  }
  async stop() {
    // Tolerates start() having failed partway: `rm -f` of a container that
    // never came up exits non-zero, which is fine.
    if (this.keep) console.log(`[scenario-smoke] kept container ${this.name}`);
    else await exec("docker", ["rm", "-f", this.name]);
  }
  describe() {
    return `docker (${this.image})`;
  }
}

async function smokeScenario(scenario, runner) {
  const { manifest } = scenario;
  const tag = `[scenario-smoke] ${manifest.area}/${manifest.slug}`;
  // start() is inside the try so a container that was created but failed
  // its readiness check is still removed by stop().
  try {
    await runner.start();
    console.log(`${tag}: ${runner.describe()}`);
    if (manifest.kind === "react") {
      await runner.prepareReactWorkspace();
      console.log(`${tag}: copied workspace/`);
    }
    if (manifest.setup) {
      const result = assertNotTimedOut(await runner.run(manifest.setup), `${manifest.slug} setup`);
      if (result.code !== 0) fail(`${manifest.slug} setup failed\n${output(result)}`);
      console.log(`${tag}: setup ok`);
    }
    for (const [index, step] of scenario.steps.entries()) {
      const stepNumber = index + 1;
      const stepEnv = { LAB_STEP: String(stepNumber) };
      const stepTag = `${manifest.slug} step ${stepNumber}`;
      if (step.setup) {
        const result = assertNotTimedOut(await runner.run(step.setup, stepEnv), `${stepTag} setup`);
        if (result.code !== 0) fail(`${stepTag} setup failed\n${output(result)}`);
      }
      if (step.verify && !step.solve) {
        fail(`${stepTag} has verify but no solve script; the smoke test cannot prove it`);
      }
      if (step.verify) {
        const before = assertNotTimedOut(await runner.run(step.verify, stepEnv), `${stepTag} verify (before solve)`);
        if (before.code === 0) {
          fail(`${stepTag} verify passed before the solution was applied; it checks nothing`);
        }
        if (!before.stdout.trim()) {
          fail(`${stepTag} verify failed without printing guidance to stdout`);
        }
      }
      if (step.solve) {
        const solved = assertNotTimedOut(await runner.run(step.solve, stepEnv), `${stepTag} solve`);
        if (solved.code !== 0) fail(`${stepTag} solve failed\n${output(solved)}`);
      }
      if (step.verify) {
        const after = assertNotTimedOut(await runner.run(step.verify, stepEnv), `${stepTag} verify (after solve)`);
        if (after.code !== 0) fail(`${stepTag} verify failed after solve\n${output(after)}`);
      }
      console.log(`${tag}: step ${stepNumber} "${step.title}" ${step.verify ? "fails→solve→passes" : "ok (no verify)"}`);
    }
  } finally {
    await runner.stop();
  }
}

async function main(argv) {
  const options = parseArgs(argv);
  const { scenarios } = await loadCatalog();
  const selected =
    options.scenarioSlugs.length === 0
      ? scenarios
      : scenarios.filter((scenario) => options.scenarioSlugs.includes(scenario.manifest.slug));
  for (const slug of options.scenarioSlugs) {
    if (!selected.some((scenario) => scenario.manifest.slug === slug)) fail(`Unknown scenario slug: ${slug}`);
  }
  const useDocker = !options.local && (await dockerAvailable());
  const image = useDocker ? await resolveImage() : null;
  if (!useDocker && !options.local) {
    console.log("[scenario-smoke] docker not available; running locally");
  }
  for (const scenario of selected) {
    const runner = useDocker
      ? new DockerRunner(scenario, options.keep, image)
      : new LocalRunner(scenario, options.keep);
    await smokeScenario(scenario, runner);
  }
  console.log(`[scenario-smoke] completed ${selected.length} scenario(s)`);
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof CatalogError ? error.message : error.message ?? error);
  process.exitCode = 1;
}
