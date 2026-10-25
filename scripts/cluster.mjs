// Local Kubernetes for the platform: a kind cluster running the dispatcher
// and the gateway from the Helm chart, with scenarios/ mounted into the node.
//
//   npm run cluster:up        create the cluster if needed, build + load images, install the chart
//   npm run cluster:deploy    build + load images and upgrade the chart (after code changes)
//   npm run cluster:status    pods in both namespaces + recent dispatcher/gateway log lines
//   npm run cluster:logs      follow dispatcher + gateway logs
//   npm run cluster:down      delete the cluster
//
// Convex URL and the runner secret come from .env.local (VITE_CONVEX_URL,
// RUNNER_SHARED_SECRET) unless CONVEX_URL / RUNNER_SHARED_SECRET are set.
// Requires: docker, kind, kubectl, helm.

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readEnvLocalValue } from "./env-local.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLUSTER = "learning-lab";
const RELEASE = "learning-lab";
const NAMESPACE = "learning-lab";
const SESSIONS_NAMESPACE = "sessions";
const IMAGES = { session: "learning-lab/session-workspace:dev", platform: "learning-lab/platform:dev" };

function fail(message) {
  throw new Error(`[cluster] ${message}`);
}

function run(command, args, { capture = false, env, allowFailure = false } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: { ...process.env, ...env },
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => reject(new Error(`${command} not found: ${error.message}`)));
    child.on("close", (code) => {
      if (code !== 0 && !allowFailure) return reject(new Error(`${command} ${args.join(" ")} exited ${code}\n${stderr}`));
      resolveRun({ code, stdout, stderr });
    });
  });
}

async function requireTools() {
  const checks = [
    ["docker", ["version"]],
    ["kind", ["version"]],
    ["kubectl", ["version", "--client"]],
    ["helm", ["version"]],
  ];
  for (const [tool, args] of checks) {
    const result = await run(tool, args, { capture: true, allowFailure: true }).catch(() => null);
    if (!result || result.code !== 0) fail(`${tool} is required (e.g. brew install ${tool})`);
  }
}

async function settings() {
  const envLocal = new URL("../.env.local", import.meta.url);
  const convexUrl = process.env.CONVEX_URL ?? (await readEnvLocalValue("VITE_CONVEX_URL", envLocal));
  const runnerSecret = process.env.RUNNER_SHARED_SECRET ?? (await readEnvLocalValue("RUNNER_SHARED_SECRET", envLocal));
  if (!convexUrl) fail("CONVEX_URL (or VITE_CONVEX_URL in .env.local) is required");
  if (!runnerSecret) fail("RUNNER_SHARED_SECRET (in .env.local) is required and must match the Convex deployment");
  return { convexUrl, runnerSecret, appUpstream: process.env.GATEWAY_APP_UPSTREAM ?? "host.docker.internal:5174" };
}

async function clusterExists() {
  const { stdout } = await run("kind", ["get", "clusters"], { capture: true, allowFailure: true });
  return stdout.split(/\r?\n/).includes(CLUSTER);
}

async function createCluster() {
  const template = await readFile(resolve(projectRoot, "deploy/kind/cluster.yaml.tpl"), "utf8");
  const rendered = template.replace("__SCENARIOS_PATH__", resolve(projectRoot, "scenarios"));
  await mkdir(resolve(projectRoot, "build"), { recursive: true });
  const configPath = resolve(projectRoot, "build/kind-cluster.yaml");
  await writeFile(configPath, rendered);
  await run("kind", ["create", "cluster", "--name", CLUSTER, "--config", configPath, "--wait", "120s"]);
}

async function buildImages() {
  await run("bash", ["images/session-workspace/build.sh"]);
  await run("docker", ["build", "-f", "images/platform/Dockerfile", "-t", IMAGES.platform, "."]);
}

async function loadImages() {
  await run("kind", ["load", "docker-image", IMAGES.session, IMAGES.platform, "--name", CLUSTER]);
}

/**
 * An interrupted `helm upgrade` (Ctrl-C, lost network) leaves the release in a
 * pending-* state that blocks every later upgrade. Roll back to the previous
 * revision when there is one, otherwise uninstall so the install can start over.
 */
async function recoverPendingRelease() {
  const { code, stdout } = await run("helm", ["status", "-n", NAMESPACE, RELEASE, "-o", "json"], { capture: true, allowFailure: true });
  if (code !== 0) return; // not installed yet
  let status;
  try {
    status = JSON.parse(stdout);
  } catch {
    return;
  }
  const state = status?.info?.status;
  if (!["pending-install", "pending-upgrade", "pending-rollback"].includes(state)) return;
  const revision = Number(status?.version ?? 1);
  console.log(`[cluster] release ${RELEASE} is ${state} (revision ${revision}); recovering`);
  if (revision > 1) await run("helm", ["rollback", "-n", NAMESPACE, RELEASE, String(revision - 1), "--wait", "--timeout", "120s"]);
  else await run("helm", ["uninstall", "-n", NAMESPACE, RELEASE, "--wait"]);
}

async function deployChart() {
  const { convexUrl, runnerSecret, appUpstream } = await settings();
  await recoverPendingRelease();
  // --set-string: these values are opaque strings (a URL with ":" and "//", a
  // secret that may look like a number or contain ","), never YAML to parse.
  await run("helm", [
    "upgrade", "--install", RELEASE, "deploy/helm/learning-lab",
    "--namespace", NAMESPACE, "--create-namespace",
    "--set-string", `convexUrl=${escapeSetValue(convexUrl)}`,
    "--set-string", `runnerSecret=${escapeSetValue(runnerSecret)}`,
    "--set-string", `gateway.appUpstream=${escapeSetValue(appUpstream)}`,
    "--set-string", `images.session=${escapeSetValue(IMAGES.session)}`,
    "--set-string", `images.platform=${escapeSetValue(IMAGES.platform)}`,
    "--wait", "--timeout", "180s",
  ]);
  // Pick up new image contents under the same tag.
  await run("kubectl", ["-n", NAMESPACE, "rollout", "restart", "deployment/llp-dispatcher", "deployment/llp-gateway"]);
  await run("kubectl", ["-n", NAMESPACE, "rollout", "status", "deployment/llp-dispatcher", "--timeout=120s"]);
  await run("kubectl", ["-n", NAMESPACE, "rollout", "status", "deployment/llp-gateway", "--timeout=120s"]);
}

/** Helm's --set grammar treats "," and "\\" specially even with --set-string; escape them. */
function escapeSetValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/,/g, "\\,");
}

async function status() {
  await run("kubectl", ["get", "pods", "-n", NAMESPACE, "-o", "wide"], { allowFailure: true });
  await run("kubectl", ["get", "pods", "-n", SESSIONS_NAMESPACE, "-o", "wide"], { allowFailure: true });
  await run("kubectl", ["-n", NAMESPACE, "logs", "deployment/llp-dispatcher", "--tail=20"], { allowFailure: true });
  await run("kubectl", ["-n", NAMESPACE, "logs", "deployment/llp-gateway", "--tail=20"], { allowFailure: true });
}

async function logs() {
  await run("kubectl", ["-n", NAMESPACE, "logs", "-f", "-l", "app.kubernetes.io/part-of=learning-lab", "--all-containers", "--prefix", "--tail=50"]);
}

async function main(argv) {
  const command = argv[0] ?? "up";
  switch (command) {
    case "up": {
      await requireTools();
      if (!(await clusterExists())) await createCluster();
      else console.log(`[cluster] kind cluster "${CLUSTER}" already exists`);
      await buildImages();
      await loadImages();
      await deployChart();
      console.log("[cluster] up. Gateway: http://127.0.0.1:8080/__llp/health ; try: npm run gateway:smoke");
      return;
    }
    case "deploy":
      await requireTools();
      if (!(await clusterExists())) fail(`cluster "${CLUSTER}" does not exist; run npm run cluster:up`);
      await buildImages();
      await loadImages();
      await deployChart();
      return;
    case "status":
      return status();
    case "logs":
      return logs();
    case "down":
      await run("kind", ["delete", "cluster", "--name", CLUSTER]);
      return;
    default:
      fail(`unknown command ${command} (up|deploy|status|logs|down)`);
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error.message ?? error);
  process.exitCode = 1;
}
