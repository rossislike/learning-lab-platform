// Browser-side client for the session gateway (ADR 0004).
//
// The app (app.<suffix>) talks to each session's endpoint hosts cross-origin:
// a one-time code is POSTed to <host>/__llp/bootstrap with credentials so the
// gateway sets its host-only cookie; afterwards fetches, the terminal
// WebSocket, and iframes on that host carry the cookie (same site, Lax).
//
// No imports and only erasable TypeScript, so `node --test` can load it
// (src/lib/gateway.test.mjs).

export type AgentSummary = {
  ready: boolean;
  phase: "starting" | "ready" | "failed";
  failure: { component: string; output: string } | null;
  scenario: { slug: string; kind: string; tabs: string[]; cwd: string; stepCount: number };
  setup: { status: string; durationMs: number | null };
  editor: { enabled: boolean; status: string; path: string };
  preview: { enabled: boolean; status: string; port: number | null };
  terminals: { id: string; exited: boolean }[];
  uptimeMs: number;
};

export type VerifyResult = {
  passed: boolean;
  output: string;
  noVerify?: boolean;
  durationMs?: number;
  timedOut?: boolean;
  reported?: boolean;
  busy?: boolean;
};

export class GatewayError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export function isAccessDenied(error: unknown) {
  return error instanceof GatewayError && (error.status === 401 || error.status === 403);
}

function origin(url: string) {
  return new URL(url).origin;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PHASES = new Set(["starting", "ready", "failed"]);

/**
 * Classify a `/ready` response body. Only a body that looks like the agent's
 * summary is returned; anything else (the gateway's `503 {"error":"session is
 * not running"}`, a 502, an HTML error page) yields null so the page keeps
 * showing its own status instead of reading fields that are not there.
 */
export function parseReadyBody(body: unknown): AgentSummary | null {
  if (!isObject(body)) return null;
  if (typeof body.phase !== "string" || !PHASES.has(body.phase)) return null;
  const { setup, preview, editor, failure } = body;
  if (!isObject(setup) || typeof setup.status !== "string") return null;
  if (!isObject(preview) || typeof preview.enabled !== "boolean" || typeof preview.status !== "string") return null;
  if (!isObject(editor) || typeof editor.enabled !== "boolean" || typeof editor.status !== "string") return null;
  if (editor.enabled && typeof editor.path !== "string") return null;
  if (failure !== null && failure !== undefined && !isObject(failure)) return null;
  return {
    ...(body as AgentSummary),
    failure: isObject(failure)
      ? { component: String(failure.component ?? "unknown"), output: String(failure.output ?? "") }
      : null,
  };
}

/** Exchange a bootstrap code for the endpoint host's cookie. */
export async function bootstrapEndpoint(endpointUrl: string, code: string) {
  const response = await fetch(`${origin(endpointUrl)}/__llp/bootstrap`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (response.status !== 204) throw new GatewayError(`bootstrap failed (${response.status})`, response.status);
}

export async function logoutEndpoint(endpointUrl: string) {
  await fetch(`${origin(endpointUrl)}/__llp/logout`, { method: "POST", credentials: "include" }).catch(() => undefined);
}

/** True when the endpoint host refuses this browser (cookie missing or revoked). */
export async function probeEndpoint(endpointUrl: string) {
  const response = await fetch(`${origin(endpointUrl)}/`, { method: "HEAD", credentials: "include", cache: "no-store" });
  return { status: response.status, denied: response.status === 401 || response.status === 403 };
}

async function gatewayJson(endpointUrl: string, path: string, init: RequestInit = {}) {
  const response = await fetch(`${origin(endpointUrl)}${path}`, { credentials: "include", cache: "no-store", ...init });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { error: text.slice(0, 200) };
  }
  if (response.status === 401 || response.status === 403) {
    throw new GatewayError("not authorized", response.status);
  }
  return { status: response.status, body };
}

/** The agent's readiness summary through the gateway (503 while starting). */
export async function fetchReady(workspaceUrl: string) {
  const { status, body } = await gatewayJson(workspaceUrl, "/ready");
  return { status, summary: parseReadyBody(body) };
}

function errorText(body: unknown, fallback: string) {
  return isObject(body) && typeof body.error === "string" ? body.error : fallback;
}

export async function verifyStep(workspaceUrl: string, stepIndex: number): Promise<VerifyResult> {
  const { status, body } = await gatewayJson(workspaceUrl, `/steps/${stepIndex}/verify`, { method: "POST" });
  if (status === 409) return { passed: false, output: "A check is already running.", busy: true };
  if (status !== 200 || !isObject(body) || typeof body.passed !== "boolean") {
    throw new GatewayError(errorText(body, `verify failed (${status})`), status);
  }
  return { ...(body as VerifyResult), output: typeof body.output === "string" ? body.output : "" };
}

/** Run a step's open hook (setup). 409 means it is already running; other failures throw. */
export async function openStep(workspaceUrl: string, stepIndex: number) {
  const { status, body } = await gatewayJson(workspaceUrl, `/steps/${stepIndex}/open`, { method: "POST" });
  if (status === 409) return;
  if (status !== 200) throw new GatewayError(errorText(body, `step setup failed (${status})`), status);
  if (isObject(body) && body.ok === false) {
    throw new GatewayError(`step setup failed${typeof body.output === "string" && body.output ? `: ${body.output}` : ""}`, status);
  }
}

export function terminalSocketUrl(workspaceUrl: string, id: string, cols: number, rows: number) {
  const base = origin(workspaceUrl).replace(/^http/, "ws");
  return `${base}/pty?id=${encodeURIComponent(id)}&cols=${cols}&rows=${rows}`;
}

/** Control frame for the agent's PTY socket: "\0" + JSON, sent as text. */
export function resizeFrame(cols: number, rows: number) {
  return `\u0000${JSON.stringify({ type: "resize", cols, rows })}`;
}

export function editorUrl(workspaceUrl: string, path: string) {
  return `${origin(workspaceUrl)}${path}`;
}
