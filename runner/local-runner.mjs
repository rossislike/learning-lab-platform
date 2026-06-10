import { ConvexHttpClient } from "convex/browser";
import { closeSync, openSync } from "node:fs";
import { spawn } from "node:child_process";
import { cp, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { hostname } from "node:os";
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
const runnerHostname = hostname();
const runnerId = process.env.LOCAL_RUNNER_ID ?? `local:${runnerHostname}:${process.pid}`;
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

function formatCommandFailure({ title, command, cwd, result, hint }) {
  return [
    title,
    hint,
    `Command: ${command}`,
    `Working directory: ${cwd}`,
    `Exit code: ${result.code}`,
    result.stdout ? `stdout:\n${result.stdout.trim()}` : undefined,
    result.stderr ? `stderr:\n${result.stderr.trim()}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function portFor(sessionId, basePort) {
  const hash = [...sessionId].reduce(
    (sum, char, index) => sum + char.charCodeAt(0) * (index + 1),
    0
  );
  return basePort + (hash % 700);
}

function editorUrlForFolder(port, folderPath) {
  const url = new URL(`http://127.0.0.1:${port}/`);
  url.searchParams.set("folder", folderPath);
  return url.toString();
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

async function findAvailablePort(preferredPort, label) {
  for (let offset = 0; offset < 100; offset += 1) {
    const port = preferredPort + offset;
    if (await isPortAvailable(port)) {
      return port;
    }
  }

  const endPort = preferredPort + 99;
  throw new Error(
    [
      `No available ${label} port found in range ${preferredPort}-${endPort}.`,
      "Stop stale local sessions or adjust LOCAL_EDITOR_BASE_PORT, LOCAL_PREVIEW_BASE_PORT, or LOCAL_TOOLS_BASE_PORT.",
    ].join("\n")
  );
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

function isPidRunning(pid) {
  if (!pid) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
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

function defaultWorkspacePath(sessionId) {
  return resolve(workspacesRoot, sessionId);
}

function defaultEditorContainerName(sessionId) {
  return `llp-${sessionId}`.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

async function isContainerRunning(containerName) {
  if (!containerName) return false;

  const result = await run(
    `docker inspect -f '{{.State.Running}}' ${containerName}`,
    projectRoot
  );
  return result.code === 0 && result.stdout.trim() === "true";
}

async function inspectLocalSessionProcesses(session) {
  if (!session.workspacePath) {
    return {
      ok: false,
      failures: ["workspace path is missing"],
      processInfo: {},
    };
  }

  const processInfo = await readProcessInfo(session.workspacePath);
  const checks = [];

  if (processInfo.previewPid) {
    checks.push({
      name: "preview",
      pid: processInfo.previewPid,
      running: isPidRunning(processInfo.previewPid),
    });
  } else {
    checks.push({ name: "preview", running: false, reason: "missing pid" });
  }

  if (processInfo.toolsPid) {
    checks.push({
      name: "tools",
      pid: processInfo.toolsPid,
      running: isPidRunning(processInfo.toolsPid),
    });
  } else {
    checks.push({ name: "tools", running: false, reason: "missing pid" });
  }

  if (processInfo.editor?.provider === "openvscode-docker") {
    const containerName =
      session.editorContainerName ?? processInfo.editor?.containerName;
    checks.push({
      name: "editor",
      containerName,
      running: await isContainerRunning(containerName),
      reason: containerName ? undefined : "missing container name",
    });
  } else if (processInfo.editor?.editorPid) {
    checks.push({
      name: "editor",
      pid: processInfo.editor.editorPid,
      running: isPidRunning(processInfo.editor.editorPid),
    });
  } else {
    checks.push({ name: "editor", running: false, reason: "missing pid" });
  }

  const failures = checks
    .filter((check) => !check.running)
    .map((check) =>
      check.reason ? `${check.name} (${check.reason})` : check.name
    );

  return {
    ok: failures.length === 0,
    failures,
    processInfo,
    checks,
  };
}

async function cleanupLocalSession(session) {
  const workspacePath = session.workspacePath ?? defaultWorkspacePath(session._id);
  const processInfo = workspacePath ? await readProcessInfo(workspacePath) : {};
  const shouldCleanContainer =
    session.editorProvider === "openvscode-docker" ||
    processInfo.editor?.provider === "openvscode-docker" ||
    (!session.editorProvider &&
      !processInfo.editor?.provider &&
      editorProvider === "openvscode-docker");
  const containerName = shouldCleanContainer
    ? session.editorContainerName ??
      processInfo.editor?.containerName ??
      defaultEditorContainerName(session._id)
    : undefined;
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
      url: editorUrlForFolder(editorPort, workspacePath),
      processInfo: { provider, editorPid, binary },
    };
  }

  if (provider === "openvscode-docker") {
    const containerName = defaultEditorContainerName(sessionId);
    await run(`docker rm -f ${containerName}`, workspacePath);
    const dockerCommand = [
      "docker run -d --rm",
      `--name ${containerName}`,
      `-p 127.0.0.1:${editorPort}:3000`,
      `-v "${workspacePath}:/home/workspace:rw"`,
      openVSCodeImage,
      "--host 0.0.0.0",
      "--port 3000",
      "--without-connection-token",
      "/home/workspace",
    ].join(" ");
    const start = await run(
      dockerCommand,
      workspacePath
    );

    await writeFile(
      logPath,
      `$ docker run gitpod/openvscode-server\n${start.stdout}\n${start.stderr}\n`
    );

    if (start.code !== 0) {
      throw new Error(
        formatCommandFailure({
          title: "OpenVSCode Docker editor failed to start.",
          command: dockerCommand,
          cwd: workspacePath,
          result: start,
          hint: [
            `Image: ${openVSCodeImage}`,
            "If this is an image pull failure, run `docker pull gitpod/openvscode-server:latest` or set OPENVSCODE_SERVER_IMAGE.",
            "If Docker Desktop is unavailable, set LOCAL_EDITOR_PROVIDER=lightweight or LOCAL_EDITOR_PROVIDER=openvscode-native.",
          ].join("\n"),
        })
      );
    }

    return {
      url: editorUrlForFolder(editorPort, "/home/workspace"),
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

async function processSession(client, session) {
  console.log(`[runner] starting session ${session._id}`);
  await cleanupLocalSession(session);
  await client.mutation(api.sessions.markStarting, { sessionId: session._id });

  const lab = await client.query(api.labs.get, { labId: session.labId });
  if (!lab) {
    throw new Error(`Lab not found for session ${session._id}`);
  }

  const templatePath = resolve(projectRoot, lab.templatePath);
  const workspacePath = defaultWorkspacePath(session._id);
  const previewPort = await findAvailablePort(
    portFor(session._id, previewBasePort),
    "preview"
  );
  const editorPort = await findAvailablePort(
    portFor(session._id, editorBasePort),
    "editor"
  );
  const toolsPort = await findAvailablePort(
    portFor(session._id, toolsBasePort),
    "tools"
  );
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
    throw new Error(
      formatCommandFailure({
        title: "Dependency install failed.",
        command: "npm ci",
        cwd: workspacePath,
        result: install,
        hint: "Check the scenario package-lock.json and npm registry access.",
      })
    );
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

  console.log(`[runner] session ${session._id}: ready for learner checks`);
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

async function reconcileLocalSessionState(client) {
  const sessions = await client.query(api.sessions.listActive, {});
  const inspectableStatuses = new Set(["running", "checking", "passed", "failed"]);

  for (const session of sessions) {
    if (session.runner !== "local" || !inspectableStatuses.has(session.status)) {
      continue;
    }

    const result = await inspectLocalSessionProcesses(session);
    if (result.ok) {
      continue;
    }

    const message = `Local runner detected dead workspace process: ${result.failures.join(", ")}`;
    console.warn(`[runner] session ${session._id}: ${message}`);
    await client.mutation(api.sessions.markErrored, {
      sessionId: session._id,
      message,
      raw: result,
    });
    const cleanupResult = await cleanupLocalSession(session);
    await client.mutation(api.sessions.markCleaned, {
      sessionId: session._id,
      summary: "Cleaned up after dead workspace process detection",
      raw: cleanupResult,
    });
  }
}

async function sendHeartbeat(client) {
  try {
    await client.mutation(api.runners.heartbeat, {
      runner: "local",
      runnerId,
      pollMs,
      pid: process.pid,
      hostname: runnerHostname,
    });
  } catch (error) {
    console.warn(
      `[runner] heartbeat failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function tick(client) {
  await sendHeartbeat(client);
  await cleanupExpiredSessions(client);
  await reconcileLocalSessionState(client);
  const sessions = await client.query(api.sessions.listStartable, { runner: "local" });

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
