// Integration test for the session-workspace image: starts a container with a
// scenario mounted at /scenario, then drives the agent the way the gateway
// and the frontend will — readiness, a terminal over WebSocket, step verify
// (fail → solve → pass), and for react scenarios the editor and preview.
//
//   npm run agent:integration                            # git/first-commit
//   npm run agent:integration -- --scenario welcome-message --keep
//   AGENT_IMAGE=learning-lab/session-workspace:dev npm run agent:integration

import { spawn } from "node:child_process";
import { loadCatalog } from "./scenario-catalog.mjs";

const IMAGE = process.env.AGENT_IMAGE ?? "learning-lab/session-workspace:dev";
const READY_TIMEOUT_MS = Number(process.env.AGENT_READY_TIMEOUT_MS ?? 5 * 60 * 1000);

function fail(message) {
  throw new Error(`[agent-integration] ${message}`);
}

function exec(command, args) {
  return new Promise((resolveExec) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolveExec({ code: code ?? 1, stdout, stderr }));
    child.on("error", (error) => resolveExec({ code: 1, stdout, stderr: error.message }));
  });
}

function parseArgs(args) {
  const options = { slug: "first-commit", keep: false };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--scenario") options.slug = args[++index];
    else if (args[index] === "--keep") options.keep = true;
    else fail(`unknown argument ${args[index]}`);
  }
  if (!options.slug) fail("--scenario requires a slug");
  return options;
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

// `/ready` is 200 as soon as the terminal is usable; setup (and the preview,
// which starts after setup) finish in the background. The integration test
// needs both, so it waits for the setup to settle and the preview to run.
async function waitForReady(base, timeoutMs, name) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let sawReady = false;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/ready`);
      last = await response.json();
      last.httpOk = response.ok;
    } catch (error) {
      last = { error: error.message };
    }
    if (last.phase === "failed") {
      const logs = await exec("docker", ["logs", "--tail", "60", name]);
      fail(`agent failed (${last.failure?.component}):\n${last.failure?.output ?? ""}\n--- docker logs ---\n${logs.stdout}${logs.stderr}`);
    }
    {
      if (last.httpOk && last.ready) {
        if (!sawReady) console.log(`  ready after ${Math.round(last.uptimeMs / 1000)} s; waiting for setup`);
        sawReady = true;
        const setupDone = last.setup.status === "passed" || last.setup.status === "none";
        const previewDone = !last.preview.enabled || last.preview.status === "running";
        if (setupDone && previewDone) return last;
      }
    }
    await sleep(1000);
  }
  const logs = await exec("docker", ["logs", "--tail", "60", name]);
  fail(
    `agent did not become ready within ${timeoutMs} ms; last /ready: ${JSON.stringify(last)}\n` +
      `--- docker logs ---\n${logs.stdout}${logs.stderr}`,
  );
}

function terminal(base) {
  const ws = new WebSocket(`${base.replace("http", "ws")}/pty?id=it&cols=100&rows=30`);
  ws.binaryType = "arraybuffer";
  let output = "";
  ws.onmessage = (event) => {
    output += typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8");
  };
  return new Promise((resolveOpen, reject) => {
    ws.onopen = () => resolveOpen({ ws, read: () => output });
    ws.onerror = () => reject(new Error("terminal WebSocket failed"));
  });
}

async function main(argv) {
  const options = parseArgs(argv);
  const { scenarios } = await loadCatalog();
  const scenario = scenarios.find((entry) => entry.manifest.slug === options.slug);
  if (!scenario) fail(`unknown scenario ${options.slug}`);
  const { manifest } = scenario;
  const name = `llp-agent-${manifest.slug}-${process.pid}`;
  const tag = `[agent-integration] ${manifest.area}/${manifest.slug}`;

  const run = await exec("docker", [
    "run", "-d", "--name", name,
    "-p", "127.0.0.1::7000",
    "-p", "127.0.0.1::5173",
    "-v", `${scenario.scenarioDir}:/scenario:ro`,
    IMAGE,
  ]);
  if (run.code !== 0) fail(`docker run failed:\n${run.stderr}`);
  console.log(`${tag}: container ${name} from ${IMAGE}`);

  const stop = async () => {
    if (options.keep) return console.log(`${tag}: kept container ${name}`);
    await exec("docker", ["rm", "-f", name]);
  };

  try {
    const ports = await exec("docker", ["port", name]);
    const agentPort = ports.stdout.match(/7000\/tcp -> 127\.0\.0\.1:(\d+)/)?.[1];
    const previewPort = ports.stdout.match(/5173\/tcp -> 127\.0\.0\.1:(\d+)/)?.[1];
    if (!agentPort) {
      const state = await exec("docker", ["inspect", "--format", "{{.State.Status}} exit={{.State.ExitCode}}", name]);
      const logs = await exec("docker", ["logs", "--tail", "60", name]);
      fail(
        `the container is ${state.stdout.trim() || "gone"}; could not read the mapped agent port.\n` +
          `--- docker logs ---\n${logs.stdout}${logs.stderr}`,
      );
    }
    const base = `http://127.0.0.1:${agentPort}`;

    const ready = await waitForReady(base, READY_TIMEOUT_MS, name);
    console.log(`${tag}: setup ${ready.setup.status} after ${Math.round(ready.uptimeMs / 1000)} s (phase ${ready.phase})`);
    if ((await fetch(`${base}/healthz`)).status !== 200) fail("/healthz is not 200");

    const term = await terminal(base);
    term.ws.send("echo integration-$((40+2)); whoami; pwd\n");
    await sleep(1500);
    const seen = term.read();
    if (!seen.includes("integration-42")) fail(`terminal did not echo:\n${seen}`);
    const user = manifest.workspace.user === "root" ? "root" : "learner";
    if (!seen.includes(user)) fail(`terminal runs as the wrong user; expected ${user}:\n${seen}`);
    if (!seen.includes(manifest.workspace.cwd)) fail(`terminal cwd is not ${manifest.workspace.cwd}:\n${seen}`);
    console.log(`${tag}: terminal ok (user ${user}, cwd ${manifest.workspace.cwd}, pty ${seen.includes("\u001b[") ? "tty" : "pipe"})`);
    term.ws.close();

    const verifiable = scenario.steps
      .map((step, index) => ({ step, index: index + 1 }))
      .filter(({ step }) => step.verify);
    for (const { step, index } of verifiable) {
      const before = await fetch(`${base}/steps/${index}/verify`, { method: "POST" }).then((r) => r.json());
      if (before.passed) fail(`step ${index} passed before the solution was applied`);
      if (!before.output) fail(`step ${index} failed without learner guidance`);
      const solve = await exec("docker", [
        "exec", "-e", "LAB_WORKSPACE=/workspace", "-e", "LAB_SCENARIO_DIR=/scenario",
        "-e", `LAB_STEP=${index}`, "-w", manifest.workspace.cwd, name,
        "bash", `/scenario/${step.solve}`,
      ]);
      if (solve.code !== 0) fail(`step ${index} solve failed:\n${solve.stdout}${solve.stderr}`);
      const after = await fetch(`${base}/steps/${index}/verify`, { method: "POST" }).then((r) => r.json());
      if (!after.passed) fail(`step ${index} failed after solve:\n${after.output}`);
      console.log(`${tag}: step ${index} "${step.title}" fails→solve→passes (${after.durationMs} ms)`);
    }

    if (manifest.kind === "react") {
      const editorPath = ready.editor.path;
      const editor = await fetch(`${base}${editorPath}`, { redirect: "manual" });
      if (editor.status >= 400) fail(`${editorPath} returned ${editor.status}`);
      const editorSlash = await fetch(`${base}/editor/`, { redirect: "manual" });
      if (editorSlash.status >= 400) fail(`/editor/ returned ${editorSlash.status}`);
      const html = await editor.text();
      if (!/workbench|vscode/i.test(html)) fail(`${editorPath} did not serve the OpenVSCode workbench`);
      console.log(`${tag}: editor proxy ok (${editor.status})`);
      const preview = await fetch(`http://127.0.0.1:${previewPort}/`);
      const previewHtml = await preview.text();
      if (!preview.ok || !previewHtml.includes("<div id=\"root\">")) fail(`preview did not serve the Vite app (${preview.status})`);
      console.log(`${tag}: preview ok on :${previewPort}`);
    }

    const state = await fetch(`${base}/state`).then((r) => r.json());
    console.log(`${tag}: ${state.terminals.length} terminal(s), steps ${state.steps.map((s) => s.status).join(",")}`);
    console.log(`${tag}: PASS`);
  } finally {
    await stop();
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error.message ?? error);
  process.exitCode = 1;
}
