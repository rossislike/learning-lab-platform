import { ConvexHttpClient } from "convex/browser";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { api } from "../convex/_generated/api.js";
import { learnerProcessEnv } from "./learner-process-env.mjs";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const workspace = args.get("--workspace");
const sessionId = args.get("--session-id");
const port = Number(args.get("--port") ?? 7300);
const host = args.get("--host") ?? process.env.WORKSPACE_SERVER_HOST ?? "127.0.0.1";
const mode = args.get("--mode") ?? "editor";
const previewUrl = args.get("--preview-url") ?? "";
const editorUrl = args.get("--editor-url") ?? "";
const validationCommand =
  args.get("--validation-command") ?? "npm test -- --run --reporter=json";
const convexUrl = process.env.CONVEX_URL || process.env.VITE_CONVEX_URL;

if (!workspace || !sessionId) {
  throw new Error("workspace-server requires --workspace and --session-id");
}

const client = convexUrl ? new ConvexHttpClient(convexUrl) : null;
const runnerSecret = await readRunnerSecret();

async function readRunnerSecret() {
  const environmentSecret = process.env.RUNNER_SHARED_SECRET;
  delete process.env.RUNNER_SHARED_SECRET;

  if (process.env.RUNNER_SECRET_STDIN !== "1") return environmentSecret;
  delete process.env.RUNNER_SECRET_STDIN;

  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  response.end(JSON.stringify(payload));
}

function sendHtml(response, html) {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
}

function safePath(inputPath = "src/App.jsx") {
  const target = resolve(workspace, inputPath);
  const rel = relative(workspace, target);
  if (rel.startsWith("..") || rel === "") {
    throw new Error("Invalid workspace path");
  }
  return target;
}

function readBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk.toString();
    });
    request.on("end", () => resolveBody(body));
    request.on("error", rejectBody);
  });
}

function run(command, cwd) {
  return new Promise((resolveRun) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: learnerProcessEnv(process.env, { NODE_ENV: "test" }),
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

function formatCommandFailure({ title, command, cwd, result, error }) {
  return [
    title,
    `Command: ${command}`,
    `Working directory: ${cwd}`,
    `Exit code: ${result.code}`,
    error ? `Report error: ${error.message}` : undefined,
    result.stdout ? `stdout:\n${result.stdout.trim()}` : undefined,
    result.stderr ? `stderr:\n${result.stderr.trim()}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function parseVitestReport(reportText) {
  const report = JSON.parse(reportText);
  const assertions = [];

  for (const suite of report.testResults ?? []) {
    for (const assertion of suite.assertionResults ?? []) {
      assertions.push({
        title: assertion.title,
        status: assertion.status,
        message: formatFailureMessage(assertion.failureMessages?.[0]),
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

function formatFailureMessage(message) {
  if (!message) return undefined;

  const ansiEscape = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  const cleanMessage = message.replace(ansiEscape, "");
  const expectedRole = cleanMessage.match(
    /Unable to find an accessible element with the role "([^"]+)" and name "([^"]+)"/
  );
  const actualHeading = cleanMessage.match(/heading:\s+Name "([^"]*)":/);

  if (expectedRole?.[1] === "heading") {
    const expected = expectedRole[2];
    const actual = actualHeading?.[1] ?? "no heading found";
    return `Expected heading "${expected}", but found "${actual}". Save src/App.jsx and run checks again.`;
  }

  return cleanMessage.split("\n").find((line) => line.trim())?.trim();
}

async function runCheck() {
  const reportPath = resolve(workspace, ".vitest-report.json");
  const command = `${validationCommand} --outputFile="${reportPath}"`;

  if (client) {
    if (!runnerSecret) throw new Error("RUNNER_SHARED_SECRET is required");
    await client.mutation(api.sessions.markChecking, { runnerSecret, sessionId });
  }

  const validation = await run(command, workspace);

  let result;
  try {
    result = parseVitestReport(await readFile(reportPath, "utf8"));
  } catch (error) {
    const summary = formatCommandFailure({
      title: "Validation command did not produce a readable Vitest report.",
      command,
      cwd: workspace,
      result: validation,
      error,
    });
    console.error(summary);
    result = {
      assertions: [],
      score: 0,
      passed: false,
      summary,
      raw: {
        command,
        cwd: workspace,
        exitCode: validation.code,
        stdout: validation.stdout,
        stderr: validation.stderr,
      },
    };
  }

  await writeFile(
    resolve(workspace, ".local-runner-result.json"),
    JSON.stringify(result, null, 2)
  );

  if (client) {
    await client.mutation(api.sessions.recordCheck, {
      runnerSecret,
      sessionId,
      passed: result.passed,
      score: result.score,
      summary: result.summary,
      raw: result,
    });
  }

  return result;
}

async function readCurrentResult() {
  try {
    return JSON.parse(
      await readFile(resolve(workspace, ".local-runner-result.json"), "utf8")
    );
  } catch {
    return null;
  }
}

function editorHtml() {
  if (mode === "tools") {
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Workspace Tools</title>
    <style>
      :root { font-family: Inter, system-ui, sans-serif; color: #17202a; background: #f7f8fb; }
      body { margin: 0; padding: 24px; }
      main { max-width: 920px; margin: 0 auto; display: grid; gap: 18px; }
      section { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 18px; }
      button { min-height: 38px; border-radius: 6px; border: 0; background: #0f766e; color: white; padding: 0 14px; font-weight: 800; cursor: pointer; }
      pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #111827; color: #f9fafb; border-radius: 8px; padding: 12px; }
      a { color: #2563eb; }
      .links { display: flex; gap: 12px; flex-wrap: wrap; }
      .health { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
      .health div { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px; }
      .health span { display: block; color: #6b7280; font-size: 0.82rem; }
    </style>
  </head>
  <body>
    <main>
      <section>
        <h1>Workspace Tools</h1>
        <p>OpenVSCode handles editing. Use this page for validation and quick links.</p>
        <p class="links">
          <a href="${editorUrl}" target="_blank" rel="noreferrer">Open OpenVSCode</a>
          <a href="${previewUrl}" target="_blank" rel="noreferrer">Open preview</a>
        </p>
        <div class="health">
          <div><span>Session</span><strong>${sessionId}</strong></div>
          <div><span>Workspace</span><strong>${workspace}</strong></div>
          <div><span>Mode</span><strong>${mode}</strong></div>
        </div>
        <button id="check">Run checks</button>
      </section>
      <section>
        <h2>Current result</h2>
        <pre id="result">Loading current result...</pre>
      </section>
    </main>
    <script>
      const result = document.getElementById("result");
      async function loadCurrentResult() {
        const response = await fetch("/api/result");
        result.textContent = JSON.stringify(await response.json(), null, 2);
      }
      document.getElementById("check").addEventListener("click", async () => {
        result.textContent = "Running checks...";
        const response = await fetch("/api/check", { method: "POST" });
        result.textContent = JSON.stringify(await response.json(), null, 2);
      });
      loadCurrentResult();
    </script>
  </body>
</html>`;
  }

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Workspace Editor</title>
    <style>
      :root { font-family: Inter, system-ui, sans-serif; color: #17202a; background: #f7f8fb; }
      body { margin: 0; }
      main { display: grid; grid-template-columns: minmax(360px, 0.9fr) minmax(420px, 1.1fr); min-height: 100vh; }
      section { padding: 18px; min-width: 0; }
      .editor { background: #111827; color: #f9fafb; }
      .toolbar { display: flex; gap: 8px; align-items: center; justify-content: space-between; margin-bottom: 12px; }
      .controls { display: flex; gap: 8px; flex-wrap: wrap; }
      button, input { font: inherit; border-radius: 6px; border: 1px solid #d1d5db; min-height: 36px; }
      button { padding: 0 12px; font-weight: 800; cursor: pointer; }
      input { padding: 0 10px; min-width: 240px; }
      textarea { width: 100%; height: calc(100vh - 112px); resize: none; border: 1px solid #374151; border-radius: 8px; background: #020617; color: #e5e7eb; padding: 14px; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
      iframe { width: 100%; height: calc(100vh - 82px); border: 1px solid #d1d5db; border-radius: 8px; background: #fff; }
      pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; max-height: 220px; overflow: auto; }
      .status { color: #d1d5db; font-size: 0.9rem; }
      a { color: #2563eb; }
      @media (max-width: 900px) { main { grid-template-columns: 1fr; } textarea, iframe { height: 60vh; } }
    </style>
  </head>
  <body>
    <main>
      <section class="editor">
        <div class="toolbar">
          <div>
            <strong>Workspace Editor</strong>
            <div class="status" id="status">Loading src/App.jsx</div>
          </div>
          <div class="controls">
            <input id="path" value="src/App.jsx" aria-label="File path" />
            <button id="load">Load</button>
            <button id="save">Save</button>
            <button id="check">Run checks</button>
          </div>
        </div>
        <textarea id="code" spellcheck="false"></textarea>
      </section>
      <section>
        <div class="toolbar">
          <strong>Preview</strong>
          <a href="${previewUrl}" target="_blank" rel="noreferrer">${previewUrl}</a>
        </div>
        <iframe src="${previewUrl}" title="Vite preview"></iframe>
        <pre id="result">No check run from editor yet.</pre>
      </section>
    </main>
    <script>
      const code = document.getElementById("code");
      const path = document.getElementById("path");
      const status = document.getElementById("status");
      const result = document.getElementById("result");

      async function loadFile() {
        const response = await fetch("/api/file?path=" + encodeURIComponent(path.value));
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error);
        code.value = payload.content;
        status.textContent = "Loaded " + payload.path;
      }

      async function saveFile() {
        const response = await fetch("/api/file", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: path.value, content: code.value })
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error);
        status.textContent = "Saved " + payload.path;
      }

      async function runChecks() {
        result.textContent = "Running checks...";
        const response = await fetch("/api/check", { method: "POST" });
        const payload = await response.json();
        result.textContent = JSON.stringify(payload, null, 2);
      }

      document.getElementById("load").addEventListener("click", () => loadFile().catch(error => status.textContent = error.message));
      document.getElementById("save").addEventListener("click", () => saveFile().catch(error => status.textContent = error.message));
      document.getElementById("check").addEventListener("click", () => runChecks().catch(error => result.textContent = error.message));
      loadFile().catch(error => status.textContent = error.message);
    </script>
  </body>
</html>`;
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);

    if (request.method === "OPTIONS") {
      sendJson(response, 200, {});
      return;
    }

    if (url.pathname === "/" || url.pathname === "/editor" || url.pathname === "/tools") {
      sendHtml(response, editorHtml());
      return;
    }

    if (url.pathname === "/api/file" && request.method === "GET") {
      const requestedPath = url.searchParams.get("path") ?? "src/App.jsx";
      sendJson(response, 200, {
        path: requestedPath,
        content: await readFile(safePath(requestedPath), "utf8"),
      });
      return;
    }

    if (url.pathname === "/api/file" && request.method === "POST") {
      const payload = JSON.parse(await readBody(request));
      await writeFile(safePath(payload.path), String(payload.content ?? ""));
      sendJson(response, 200, { path: payload.path, saved: true });
      return;
    }

    if (url.pathname === "/api/check" && request.method === "POST") {
      sendJson(response, 200, await runCheck());
      return;
    }

    if (url.pathname === "/api/result" && request.method === "GET") {
      sendJson(response, 200, {
        sessionId,
        previewUrl,
        editorUrl,
        workspace,
        result: await readCurrentResult(),
      });
      return;
    }

    if (url.pathname === "/api/health" && request.method === "GET") {
      sendJson(response, 200, {
        ok: true,
        sessionId,
        mode,
      });
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(port, host, () => {
  console.log(`[workspace-server] ${sessionId} listening on http://${host}:${port}/editor`);
});
