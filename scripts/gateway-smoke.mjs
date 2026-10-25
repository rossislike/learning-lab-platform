// End-to-end smoke test for the local stack (Phase 3 exit criterion):
//   request a session in Convex → dispatcher launches a pod on kind →
//   session becomes running → bootstrap codes → gateway cookie →
//   /ready and a terminal over WebSocket through the gateway → verify a step →
//   stop → pod cleaned up.
//
// Runs from the host against the Convex dev deployment (auth-disabled local
// mode) and the gateway on 127.0.0.1:8080 (Host header set by hand, since
// *.lab.localhost does not resolve outside browsers).
//
//   npm run gateway:smoke                         # git/first-commit
//   npm run gateway:smoke -- --scenario welcome-message --keep
//
// With --keep the session stays running and a browser URL for the dev
// terminal page is printed (Chrome/Firefox resolve *.localhost to loopback).

import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { readEnvLocalValue } from "./env-local.mjs";

const GATEWAY = { host: process.env.GATEWAY_ADDRESS ?? "127.0.0.1", port: Number(process.env.GATEWAY_PORT ?? 8080) };
const APP_ORIGIN = process.env.GATEWAY_APP_ORIGIN ?? "http://app.lab.localhost:8080";
const READY_TIMEOUT_MS = Number(process.env.SMOKE_READY_TIMEOUT_MS ?? 5 * 60 * 1000);

function fail(message) {
  throw new Error(`[gateway-smoke] ${message}`);
}

function parseArgs(args) {
  const options = { slug: "first-commit", keep: false, label: "gateway-smoke" };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--scenario") options.slug = args[++index];
    else if (args[index] === "--keep") options.keep = true;
    else if (args[index] === "--label") options.label = args[++index];
    else fail(`unknown argument ${args[index]}`);
  }
  return options;
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/** Learner-side Convex HTTP API (no runner secret; auth-disabled local mode). */
function learnerConvex(convexUrl) {
  const base = convexUrl.replace(/\/+$/, "");
  async function call(kind, path, args) {
    const response = await fetch(`${base}/api/${kind}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, args, format: "json" }),
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok && body.status === "success") return body.value;
    throw new Error(`${path}: ${body.errorMessage ?? `HTTP ${response.status}`}`);
  }
  return { query: (path, args = {}) => call("query", path, args), mutation: (path, args = {}) => call("mutation", path, args) };
}

function gatewayRequest(path, { host, method = "GET", headers = {}, body } = {}) {
  return new Promise((resolveReq, reject) => {
    const req = httpRequest({ host: GATEWAY.host, port: GATEWAY.port, path, method, headers: { host, ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolveReq({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function maskedTextFrame(text) {
  const payload = Buffer.from(text);
  const mask = Buffer.from([7, 7, 7, 7]);
  const header = payload.length < 126 ? Buffer.from([0x81, 0x80 | payload.length]) : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
  const frame = Buffer.alloc(header.length + 4 + payload.length);
  header.copy(frame, 0);
  mask.copy(frame, header.length);
  for (let i = 0; i < payload.length; i += 1) frame[header.length + 4 + i] = payload[i] ^ mask[i % 4];
  return frame;
}

function terminalThroughGateway({ host, cookie, input, waitMs = 2000 }) {
  return new Promise((resolveTerminal, reject) => {
    const socket = connect(GATEWAY.port, GATEWAY.host);
    let data = Buffer.alloc(0);
    let sent = false;
    socket.on("connect", () => {
      socket.write(
        `GET /pty?id=smoke&cols=100&rows=30 HTTP/1.1\r\nHost: ${host}\r\nCookie: ${cookie}\r\nOrigin: ${APP_ORIGIN}\r\n` +
          "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
      );
    });
    socket.on("data", (chunk) => {
      data = Buffer.concat([data, chunk]);
      if (!sent && data.includes("101 Switching Protocols")) {
        sent = true;
        socket.write(maskedTextFrame(input));
        setTimeout(() => socket.end(), waitMs);
      }
    });
    socket.on("close", () => resolveTerminal(data.toString("latin1")));
    socket.on("error", reject);
  });
}

async function main(argv) {
  const options = parseArgs(argv);
  const envLocal = new URL("../.env.local", import.meta.url);
  const convexUrl = process.env.CONVEX_URL ?? (await readEnvLocalValue("VITE_CONVEX_URL", envLocal));
  if (!convexUrl) fail("CONVEX_URL or VITE_CONVEX_URL in .env.local is required");
  const convex = learnerConvex(convexUrl);
  const tag = `[gateway-smoke] ${options.slug}`;

  const health = await gatewayRequest("/__llp/health", { host: "x" }).catch((error) => fail(`gateway unreachable at ${GATEWAY.host}:${GATEWAY.port}: ${error.message}`));
  if (health.status !== 200) fail(`gateway health returned ${health.status}`);

  const lab = await convex.query("labs:getBySlug", { slug: options.slug });
  if (!lab) fail(`scenario ${options.slug} is not seeded (run npm run scenarios:import and Seed scenarios)`);

  let sessionId;
  try {
    sessionId = await convex.mutation("sessions:request", { labId: lab._id, learnerLabel: options.label });
  } catch (error) {
    fail(`${error.message}\nIf a previous smoke session is still active, stop it from the dashboard or wait for it to expire.`);
  }
  console.log(`${tag}: requested session ${sessionId}`);

  const deadline = Date.now() + READY_TIMEOUT_MS;
  let session;
  let lastStatus = "";
  while (Date.now() < deadline) {
    ({ session } = await convex.query("sessions:getWithEvents", { sessionId }));
    if (session.status !== lastStatus) {
      lastStatus = session.status;
      console.log(`${tag}: session ${session.status}${session.podName ? ` (pod ${session.podName})` : ""}`);
    }
    if (session.status === "running") break;
    if (["errored", "expired", "stopped"].includes(session.status)) {
      const { events } = await convex.query("sessions:getWithEvents", { sessionId });
      fail(`session ended as ${session.status}:\n${events.map((event) => `  ${event.level} ${event.message}`).join("\n")}`);
    }
    await sleep(2000);
  }
  if (session.status !== "running") fail(`session did not reach running within ${READY_TIMEOUT_MS} ms (status ${session.status}); check npm run cluster:status`);
  console.log(`${tag}: workspace ${session.workspaceUrl}`);

  const bootstrap = await convex.mutation("workspaceAccess:issueBootstrap", { sessionId });
  const wsHost = new URL(session.workspaceUrl).host;
  const exchange = await gatewayRequest("/__llp/bootstrap", {
    host: wsHost,
    method: "POST",
    headers: { origin: APP_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ code: bootstrap.codes.workspace }),
  });
  if (exchange.status !== 204) fail(`bootstrap returned ${exchange.status}: ${exchange.text}`);
  const cookie = String(exchange.headers["set-cookie"]).split(";")[0];
  console.log(`${tag}: bootstrap ok, cookie ${cookie.split("=")[0]}`);

  const ready = await gatewayRequest("/ready", { host: wsHost, headers: { cookie } });
  if (ready.status !== 200) fail(`/ready through the gateway returned ${ready.status}: ${ready.text}`);
  const readyBody = JSON.parse(ready.text);
  console.log(`${tag}: agent ready (setup ${readyBody.setup.status}, editor ${readyBody.editor.status}, preview ${readyBody.preview.status})`);
  if ((await gatewayRequest("/ready", { host: wsHost })).status !== 401) fail("gateway served /ready without a cookie");

  const output = await terminalThroughGateway({ host: wsHost, cookie, input: "echo smoke-$((40+2)); whoami\n" });
  if (!output.includes("101 Switching Protocols")) fail(`terminal upgrade failed:\n${output.slice(0, 400)}`);
  if (!output.includes("smoke-42")) fail(`terminal did not echo through the gateway:\n${output.slice(-400)}`);
  console.log(`${tag}: terminal ok through the gateway`);

  const verify = await gatewayRequest("/steps/1/verify", { host: wsHost, method: "POST", headers: { cookie } });
  const verifyBody = JSON.parse(verify.text);
  console.log(`${tag}: step 1 verify → passed=${verifyBody.passed} reported=${verifyBody.reported}${verifyBody.noVerify ? " (no verify script)" : ""}`);
  if (!verifyBody.noVerify && verifyBody.reported !== true) fail("the agent could not report the step result to Convex (check SESSION_TOKEN wiring)");
  const steps = await convex.query("steps:listForSession", { sessionId });
  console.log(`${tag}: Convex sessionSteps: ${JSON.stringify(steps.results)}`);

  if (bootstrap.codes.preview) {
    const pvHost = new URL(session.previewUrl).host;
    const pvExchange = await gatewayRequest("/__llp/bootstrap", {
      host: pvHost,
      method: "POST",
      headers: { origin: APP_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ code: bootstrap.codes.preview }),
    });
    if (pvExchange.status !== 204) fail(`preview bootstrap returned ${pvExchange.status}`);
    const pvCookie = String(pvExchange.headers["set-cookie"]).split(";")[0];
    const preview = await gatewayRequest("/", { host: pvHost, headers: { cookie: pvCookie } });
    console.log(`${tag}: preview through the gateway → ${preview.status}${preview.text.includes('id="root"') ? " (Vite app)" : ""}`);
  }

  if (options.keep) {
    const devBootstrap = await convex.mutation("workspaceAccess:issueBootstrap", { sessionId });
    console.log(`${tag}: kept running. Open in Chrome/Firefox (one-time link, 60 s):`);
    console.log(`  ${session.workspaceUrl}/__llp/dev?code=${devBootstrap.codes.workspace}`);
    console.log(`${tag}: stop it later from the dashboard (Stop), or let it expire.`);
    return;
  }

  await convex.mutation("sessions:stop", { sessionId });
  const stopDeadline = Date.now() + 60_000;
  while (Date.now() < stopDeadline) {
    ({ session } = await convex.query("sessions:getWithEvents", { sessionId }));
    if (session.cleanedAt) break;
    await sleep(2000);
  }
  if (!session.cleanedAt) fail(`session was not cleaned up within 60 s (status ${session.status})`);
  console.log(`${tag}: stopped and cleaned (${session.cleanupSummary})`);
  console.log(`${tag}: PASS`);
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error.message ?? error);
  process.exitCode = 1;
}
