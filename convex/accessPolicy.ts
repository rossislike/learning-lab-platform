// Pure rules for ADR 0004 workspace access: endpoint scopes, hostnames,
// bootstrap codes, and access grants. No Convex imports so it is unit-tested
// directly and shared conceptually with the gateway.

export const ENDPOINT_SCOPES = ["workspace", "preview"] as const;
export type EndpointScope = (typeof ENDPOINT_SCOPES)[number];

export const HOST_PREFIX: Record<EndpointScope, string> = { workspace: "ws", preview: "pv" };

export const BOOTSTRAP_CODE_TTL_MS = 60 * 1000;
export const OWNER_GRANT_MAX_MS = 60 * 60 * 1000;
export const ROUTE_ID_PATTERN = /^[a-z0-9]{20,32}$/;
export const CODE_PATTERN = /^[0-9a-f]{64}$/;

export function isEndpointScope(value: unknown): value is EndpointScope {
  return typeof value === "string" && (ENDPOINT_SCOPES as readonly string[]).includes(value);
}

export function endpointHost(scope: EndpointScope, routeId: string, suffix: string) {
  return `${HOST_PREFIX[scope]}-${routeId}.${suffix}`;
}

/** Parses `ws-<routeId>.<suffix>` / `pv-<routeId>.<suffix>` (port ignored). */
export function parseEndpointHost(hostHeader: string | undefined, suffix: string) {
  if (!hostHeader) return null;
  const host = hostHeader.toLowerCase().replace(/:\d+$/, "");
  const tail = `.${suffix.toLowerCase()}`;
  if (!host.endsWith(tail)) return null;
  const label = host.slice(0, -tail.length);
  const match = label.match(/^(ws|pv)-([a-z0-9]+)$/);
  if (!match) return null;
  const scope: EndpointScope = match[1] === "ws" ? "workspace" : "preview";
  const routeId = match[2];
  if (!ROUTE_ID_PATTERN.test(routeId)) return null;
  return { scope, routeId };
}

export function grantExpiry(now: number, sessionExpiresAt: number) {
  return Math.min(sessionExpiresAt, now + OWNER_GRANT_MAX_MS);
}

export type BootstrapRecord = {
  routeId: string;
  scope: EndpointScope;
  expiresAt: number;
  consumedAt?: number;
};

/** Why a bootstrap code cannot be consumed, or null when it can. */
export function bootstrapRejection(
  record: BootstrapRecord | null,
  { routeId, scope, now, sessionUsable }: { routeId: string; scope: EndpointScope; now: number; sessionUsable: boolean }
) {
  if (!record) return "unknown";
  if (record.consumedAt !== undefined) return "consumed";
  if (now > record.expiresAt) return "expired";
  if (record.routeId !== routeId) return "route-mismatch";
  if (record.scope !== scope) return "scope-mismatch";
  if (!sessionUsable) return "session-not-usable";
  return null;
}

export type GrantRecord = {
  routeId: string;
  scope: EndpointScope;
  status: "active" | "revoked" | "expired";
  expiresAt: number;
};

export function grantRejection(
  record: GrantRecord | null,
  { routeId, scope, now, sessionUsable, verifierMatches }: {
    routeId: string;
    scope: EndpointScope;
    now: number;
    sessionUsable: boolean;
    verifierMatches: boolean;
  }
) {
  if (!record) return "unknown";
  if (!verifierMatches) return "verifier-mismatch";
  if (record.status !== "active") return record.status;
  if (now > record.expiresAt) return "expired";
  if (record.routeId !== routeId) return "route-mismatch";
  if (record.scope !== scope) return "scope-mismatch";
  if (!sessionUsable) return "session-not-usable";
  return null;
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6 = /^[0-9a-f:]{2,39}$/i;

/**
 * A pod IP the gateway may proxy to: a syntactically valid IPv4/IPv6 address
 * that is not loopback, link-local or unspecified. Whatever the dispatcher
 * records as `podIp` becomes an upstream for every request on that route, so
 * both the writer (sessions.updateRunnerMetadata) and the reader (the gateway)
 * apply this check.
 */
export function isAllowedPodIp(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 45) return false;
  if (IPV4.test(value)) {
    const [a, b] = value.split(".").map(Number);
    if (a === 127 || a === 0) return false; // loopback, "this network"
    if (a === 169 && b === 254) return false; // link-local / cloud metadata
    return true;
  }
  if (!value.includes(":") || !IPV6.test(value)) return false;
  const groups = value.split("::");
  if (groups.length > 2) return false;
  const parts = value.split(":").filter(Boolean);
  if (parts.length > 8 || parts.some((part) => part.length > 4)) return false;
  if (groups.length === 1 && parts.length !== 8) return false;
  const expanded = expandIpv6(value);
  if (expanded === "0000:0000:0000:0000:0000:0000:0000:0001") return false; // ::1
  if (expanded === "0000:0000:0000:0000:0000:0000:0000:0000") return false; // ::
  if (/^fe[89ab]/i.test(expanded)) return false; // fe80::/10 link-local
  if (/^0000:0000:0000:0000:0000:ffff:/i.test(expanded)) {
    // IPv4-mapped: apply the IPv4 rules to the embedded address.
    const tail = expanded.slice(-9).split(":");
    const a = parseInt(tail[0].slice(0, 2), 16);
    const b = parseInt(tail[0].slice(2), 16);
    if (a === 127 || a === 0 || (a === 169 && b === 254)) return false;
  }
  return true;
}

function expandIpv6(value: string) {
  const [head, tail = ""] = value.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  const missing = 8 - headParts.length - tailParts.length;
  const parts = [...headParts, ...Array(Math.max(missing, 0)).fill("0"), ...tailParts];
  return parts.map((part) => part.padStart(4, "0").toLowerCase()).join(":");
}
