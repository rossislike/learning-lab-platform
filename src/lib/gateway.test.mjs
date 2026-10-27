import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  fetchReady,
  GatewayError,
  isAccessDenied,
  parseReadyBody,
  resizeFrame,
  terminalSocketUrl,
  verifyStep,
} from "./gateway.ts";

const summary = {
  ready: false,
  phase: "starting",
  failure: null,
  scenario: { slug: "first-commit", kind: "terminal", tabs: ["terminal"], cwd: "/workspace", stepCount: 3 },
  setup: { status: "running", durationMs: null },
  editor: { enabled: false, status: "disabled", path: "/editor?folder=%2Fworkspace" },
  preview: { enabled: false, status: "disabled", port: null },
  terminals: [],
  uptimeMs: 10,
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function respondWith(status, body) {
  globalThis.fetch = async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

test("parseReadyBody accepts the agent summary", () => {
  assert.deepEqual(parseReadyBody(summary), summary);
  const failed = { ...summary, phase: "failed", failure: { component: "setup", output: "npm ERR!" } };
  assert.deepEqual(parseReadyBody(failed).failure, { component: "setup", output: "npm ERR!" });
});

test("parseReadyBody rejects error bodies and partial summaries", () => {
  assert.equal(parseReadyBody({ error: "session is not running" }), null);
  assert.equal(parseReadyBody({ error: "gateway error" }), null);
  assert.equal(parseReadyBody(null), null);
  assert.equal(parseReadyBody("oops"), null);
  assert.equal(parseReadyBody([]), null);
  assert.equal(parseReadyBody({ ...summary, phase: "weird" }), null);
  assert.equal(parseReadyBody({ ...summary, setup: undefined }), null);
  assert.equal(parseReadyBody({ ...summary, preview: { status: "running" } }), null);
  assert.equal(parseReadyBody({ ...summary, editor: null }), null);
  assert.equal(parseReadyBody({ ...summary, editor: { enabled: true, status: "running" } }), null);
  assert.equal(parseReadyBody({ ...summary, failure: "x" }), null);
});

test("fetchReady: agent 503 while starting is a summary", async () => {
  respondWith(503, summary);
  assert.deepEqual(await fetchReady("http://ws-r1.lab.localhost:8080"), { status: 503, summary });
});

test("fetchReady: gateway 503 {error} is not a summary and does not throw", async () => {
  respondWith(503, { error: "session is not running" });
  assert.deepEqual(await fetchReady("http://ws-r1.lab.localhost:8080"), { status: 503, summary: null });
  respondWith(502, "<html>bad gateway</html>");
  assert.deepEqual(await fetchReady("http://ws-r1.lab.localhost:8080"), { status: 502, summary: null });
});

test("fetchReady: 401/403 throw an access-denied GatewayError", async () => {
  for (const status of [401, 403]) {
    respondWith(status, { error: "not authorized" });
    await assert.rejects(fetchReady("http://ws-r1.lab.localhost:8080"), (error) => {
      assert.ok(error instanceof GatewayError);
      assert.equal(error.status, status);
      assert.equal(isAccessDenied(error), true);
      return true;
    });
  }
  assert.equal(isAccessDenied(new GatewayError("x", 500)), false);
  assert.equal(isAccessDenied(new Error("x")), false);
});

test("verifyStep: 409 is busy, other failures throw with the agent's error", async () => {
  respondWith(409, { error: "verify already running" });
  assert.equal((await verifyStep("http://ws-r1.lab.localhost:8080", 1)).busy, true);
  respondWith(404, { error: "no such step" });
  await assert.rejects(verifyStep("http://ws-r1.lab.localhost:8080", 9), /no such step/);
  respondWith(503, { error: "session is not running" });
  await assert.rejects(verifyStep("http://ws-r1.lab.localhost:8080", 1), /session is not running/);
  respondWith(200, { passed: true, output: "ok", reported: false });
  assert.deepEqual(await verifyStep("http://ws-r1.lab.localhost:8080", 1), { passed: true, output: "ok", reported: false });
});

test("terminal socket URL and resize control frame", () => {
  assert.equal(
    terminalSocketUrl("https://ws-r1.dev.example.com/some/path", "2", 120, 40),
    "wss://ws-r1.dev.example.com/pty?id=2&cols=120&rows=40"
  );
  assert.equal(terminalSocketUrl("http://ws-r1.lab.localhost:8080", "1", 80, 24), "ws://ws-r1.lab.localhost:8080/pty?id=1&cols=80&rows=24");
  const frame = resizeFrame(80, 24);
  assert.equal(frame[0], "\u0000");
  assert.deepEqual(JSON.parse(frame.slice(1)), { type: "resize", cols: 80, rows: 24 });
});
