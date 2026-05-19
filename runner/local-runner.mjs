import { ConvexHttpClient } from "convex/browser";
import { closeSync, openSync } from "node:fs";
import { spawn } from "node:child_process";
import { cp, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { api } from "../convex/_generated/api.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const workspacesRoot = resolve(projectRoot, "lab-workspaces");
const once = process.argv.includes("--once");
const pollMs = Number(process.env.LOCAL_RUNNER_POLL_MS ?? 3000);
const previewBasePort = Number(process.env.LOCAL_PREVIEW_BASE_PORT ?? 6200);
const editorBasePort = Number(process.env.LOCAL_EDITOR_BASE_PORT ?? 7200);
const toolsBasePort = Number(process.env.LOCAL_TOOLS_BASE_PORT ?? 8200);
const editorProvider = process.env.LOCAL_EDITOR_PROVIDER ?? "openvscode-docker";
const openVSCodeImage =
  process.env.OPENVSCODE_SERVER_IMAGE ?? "gitpod/openvscode-server:latest";

function readConvexUrl() {
  if (process.env.CONVEX_URL) return process.env.CONVEX_URL;
  if (process.env.VITE_CONVEX_URL) return process.env.VITE_CONVEX_URL;

  try {
    const envLocal = new URL("../.env.local", import.meta.url);
    return readFile(envLocal, "utf8").then((contents) => {
      const line = contents
        .split(/\r?\n/)
        .find((entry) => entry.startsWith("VITE_CONVEX_URL="));
      return line?.split("=").slice(1).join("=").trim();
    });
  } catch {
    return undefined;
  }
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

function portFor(sessionId, basePort) {
  const hash = [...sessionId].reduce(
    (sum, char, index) => sum + char.charCodeAt(0) * (index + 1),
    0
  );
  return basePort + (hash % 700);
}

function isPortAvailable(port) {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.once("error", () => resolvePort(false));
    server.once("listening", () => {
      server.close(() => resolvePort(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function findAvailablePort(preferredPort) {
  for (let offset = 0; offset < 100; offset += 1) {
    const port = preferredPort + offset;
    if (await isPortAvailable(port)) {
      return port;
    }
  }

  throw new Error(`No available port found starting at ${preferredPort}`);
}

async function appendLog(path, line) {
  const handle = await open(path, "a");
  await handle.appendFile(`${new Date().toISOString()} ${line}\n`);
  await handle.close();
}

async function startDetachedProcess(command, args, cwd, logPath, env = {}) {
  await appendLog(logPath, `$ ${command} ${args.join(" ")}`);
  const output = openSync(logPath, "a");
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ["ignore", output, output],
  });
  child.unref();
  closeSync(output);
  return child.pid;
}

async function stopPid(pid) {
  if (!pid) return false;

  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

async function readProcessInfo(workspacePath) {
  try {
    return JSON.parse(
      await readFile(resolve(workspacePath, ".local-runner-processes.json"), "utf8")
    );
  } catch {
    return {};
  }
}

async function cleanupLocalSession(session) {
  const workspacePath = session.workspacePath;
  const processInfo = workspacePath ? await readProcessInfo(workspacePath) : {};
  const containerName =
    session.editorContainerName ?? processInfo.editor?.containerName;
  const stopped = {
    previewPid: await stopPid(processInfo.previewPid),
    toolsPid: await stopPid(processInfo.toolsPid),
    editorPid: await stopPid(processInfo.editor?.editorPid),
    containerName,
    containerStopped: false,
  };

  if (containerName) {
    const result = await run(`docker rm -f ${containerName}`, projectRoot);
    stopped.containerStopped = result.code === 0;
  }

  return stopped;
}

async function startEditor({
  provider,
  sessionId,
  workspacePath,
  editorPort,
  previewUrl,
  validationCommand,
  logPath,
}) {
  if (provider === "lightweight") {
    const editorPid = await startDetachedProcess(
      "node",
      [
        resolve(projectRoot, "runner/workspace-server.mjs"),
        "--mode",
        "editor",
        "--workspace",
        workspacePath,
        "--session-id",
        sessionId,
        "--port",
        String(editorPort),
        "--preview-url",
        previewUrl,
        "--validation-command",
        validationCommand,
      ],
      projectRoot,
      logPath,
      { CONVEX_URL: await readConvexUrl() }
    );

    return {
      url: `http://127.0.0.1:${editorPort}/editor`,
      processInfo: { provider, editorPid },
    };
  }

  if (provider === "openvscode-native") {
    const binary = process.env.OPENVSCODE_SERVER_BIN || "openvscode-server";
    const editorPid = await startDetachedProcess(
      binary,
      [
        "--host",
        "127.0.0.1",
        "--port",
        String(editorPort),
        "--without-connection-token",
        workspacePath,
      ],
      workspacePath,
      logPath
    );

    return {
      url: `http://127.0.0.1:${editorPort}`,
      processInfo: { provider, editorPid, binary },
    };
  }

  if (provider === "openvscode-docker") {
    const containerName = `llp-${sessionId}`.replace(/[^a-zA-Z0-9_.-]/g, "-");
    await run(`docker rm -f ${containerName}`, workspacePath);
    const start = await run(
      [
        "docker run -d --rm",
        `--name ${containerName}`,
        `-p 127.0.0.1:${editorPort}:3000`,
        `-v "${workspacePath}:/home/workspace:rw"`,
        openVSCodeImage,
        "--host 0.0.0.0",
        "--port 3000",
        "--without-connection-token",
        "/home/workspace",
      ].join(" "),
      workspacePath
    );

    await writeFile(
      logPath,
      `$ docker run gitpod/openvscode-server\n${start.stdout}\n${start.stderr}\n`
    );

    if (start.code !== 0) {
      throw new Error(
        [
          "OpenVSCode Docker editor failed to start.",
          "Make sure Docker Desktop is running, or set LOCAL_EDITOR_PROVIDER=openvscode-native with OPENVSCODE_SERVER_BIN.",
          start.stderr || start.stdout,
        ].join("\n")
      );
    }

    return {
      url: `http://127.0.0.1:${editorPort}`,
      processInfo: {
        provider,
        containerName,
        containerId: start.stdout.trim(),
        image: openVSCodeImage,
      },
    };
  }

  throw new Error(
    `Unsupported LOCAL_EDITOR_PROVIDER=${provider}. Use openvscode-docker, openvscode-native, or lightweight.`
  );
}

function parseVitestReport(reportText) {
  const report = JSON.parse(reportText);
  const assertions = [];

  for (const suite of report.testResults ?? []) {
    for (const assertion of suite.assertionResults ?? []) {
      assertions.push({
        title: assertion.title,
        status: assertion.status,
      });
    }
  }

  const passed = assertions.filter((assertion) => assertion.status === "passed").length;
  const total = assertions.length;

  return {
    assertions,
    score: total === 0 ? 0 : Math.round((passed / total) * 100),
    passed: total > 0 && passed === total,
    summary: `${passed}/${total} validation checks passed`,
  };
}

async function processSession(client, session) {
  console.log(`[runner] starting session ${session._id}`);
  await client.mutation(api.sessions.markStarting, { sessionId: session._id });

  const lab = await client.query(api.labs.get, { labId: session.labId });
  if (!lab) {
    throw new Error(`Lab not found for session ${session._id}`);
  }

  const templatePath = resolve(projectRoot, lab.templatePath);
  const workspacePath = resolve(workspacesRoot, session._id);
  const reportPath = resolve(workspacePath, ".vitest-report.json");
  const previewPort = await findAvailablePort(portFor(session._id, previewBasePort));
  const editorPort = await findAvailablePort(portFor(session._id, editorBasePort));
  const toolsPort = await findAvailablePort(portFor(session._id, toolsBasePort));
  const previewUrl = `http://127.0.0.1:${previewPort}`;
  const toolsUrl = `http://127.0.0.1:${toolsPort}/tools`;

  await rm(workspacePath, { recursive: true, force: true });
  await mkdir(workspacesRoot, { recursive: true });
  await cp(templatePath, workspacePath, {
    recursive: true,
    filter: (path) =>
      !path.includes("/node_modules/") &&
      !path.endsWith("/node_modules") &&
      !path.includes("/dist/") &&
      !path.endsWith("/dist"),
  });

  const install = await run("npm ci", workspacePath);
  if (install.code !== 0) {
    throw new Error(`npm ci failed:\n${install.stderr || install.stdout}`);
  }

  const editor = await startEditor({
    provider: editorProvider,
    sessionId: session._id,
    workspacePath,
    editorPort,
    previewUrl,
    validationCommand: lab.validationCommand,
    logPath: resolve(workspacePath, ".openvscode.log"),
  });
  const previewPid = await startDetachedProcess(
    "npm",
    ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(previewPort)],
    workspacePath,
    resolve(workspacePath, ".preview.log")
  );
  const toolsPid = await startDetachedProcess(
    "node",
    [
      resolve(projectRoot, "runner/workspace-server.mjs"),
      "--mode",
      "tools",
      "--workspace",
      workspacePath,
      "--session-id",
      session._id,
      "--port",
      String(toolsPort),
      "--preview-url",
      previewUrl,
      "--editor-url",
      editor.url,
      "--validation-command",
      lab.validationCommand,
    ],
    projectRoot,
    resolve(workspacePath, ".tools.log"),
    { CONVEX_URL: await readConvexUrl() }
  );

  await writeFile(
    resolve(workspacePath, ".local-runner-processes.json"),
    JSON.stringify(
      {
        previewPid,
        toolsPid,
        previewPort,
        editorPort,
        toolsPort,
        editor: editor.processInfo,
      },
      null,
      2
    )
  );

  await client.mutation(api.sessions.updateRunnerMetadata, {
    sessionId: session._id,
    workspaceUrl: editor.url,
    previewUrl,
    terminalUrl: toolsUrl,
    editorProvider,
    editorContainerName: editor.processInfo.containerName,
    editorPort,
    previewPort,
    toolsPort,
    workspacePath,
  });

  await client.mutation(api.sessions.markRunning, {
    sessionId: session._id,
    workspaceUrl: editor.url,
    previewUrl,
    terminalUrl: toolsUrl,
  });

  await client.mutation(api.sessions.markChecking, { sessionId: session._id });
  const validationCommand = `${lab.validationCommand} --outputFile="${reportPath}"`;
  const validation = await run(validationCommand, workspacePath);

  let result;
  try {
    result = parseVitestReport(await readFile(reportPath, "utf8"));
  } catch (error) {
    result = {
      assertions: [],
      score: 0,
      passed: false,
      summary: `Validation did not produce a readable Vitest report: ${error.message}`,
      raw: {
        exitCode: validation.code,
        stdout: validation.stdout,
        stderr: validation.stderr,
      },
    };
  }

  await writeFile(
    resolve(workspacePath, ".local-runner-result.json"),
    JSON.stringify(result, null, 2)
  );

  await client.mutation(api.sessions.recordCheck, {
    sessionId: session._id,
    passed: result.passed,
    score: result.score,
    summary: result.summary,
    raw: result,
  });

  console.log(`[runner] session ${session._id}: ${result.summary}`);
}

async function cleanupExpiredSessions(client) {
  const expired = await client.query(api.sessions.listExpired, {});

  for (const session of expired) {
    console.log(`[runner] expiring session ${session._id}`);
    await client.mutation(api.sessions.markExpired, {
      sessionId: session._id,
      reason: "Session TTL expired",
    });
  }
}

async function cleanupStoppedSessions(client) {
  const sessions = await client.query(api.sessions.listCleanupNeeded, {
    runner: "local",
  });

  for (const session of sessions) {
    const result = await cleanupLocalSession(session);
    await client.mutation(api.sessions.markCleaned, {
      sessionId: session._id,
      summary: "Local runner resources cleaned up",
      raw: result,
    });
    console.log(`[runner] cleaned session ${session._id}`);
  }
}

async function tick(client) {
  await cleanupExpiredSessions(client);
  const sessions = await client.query(api.sessions.listRequested, { runner: "local" });

  for (const session of sessions) {
    try {
      await processSession(client, session);
    } catch (error) {
      console.error(`[runner] session ${session._id} failed`, error);
      await client.mutation(api.sessions.markErrored, {
        sessionId: session._id,
        message: error instanceof Error ? error.message : String(error),
      });
      const cleanupResult = await cleanupLocalSession(session);
      await client.mutation(api.sessions.markCleaned, {
        sessionId: session._id,
        summary: "Cleaned up after runner error",
        raw: cleanupResult,
      });
    }
  }

  await cleanupStoppedSessions(client);
  return sessions.length;
}

async function main() {
  const convexUrl = await readConvexUrl();
  if (!convexUrl) {
    throw new Error("Set VITE_CONVEX_URL in .env.local or CONVEX_URL in the environment.");
  }

  const client = new ConvexHttpClient(convexUrl);

  if (once) {
    const count = await tick(client);
    console.log(`[runner] processed ${count} requested session(s)`);
    return;
  }

  console.log(`[runner] polling Convex every ${pollMs}ms`);
  while (true) {
    await tick(client);
    await new Promise((resolvePoll) => setTimeout(resolvePoll, pollMs));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
