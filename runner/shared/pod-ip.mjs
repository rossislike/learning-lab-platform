// Mirror of isAllowedPodIp in convex/accessPolicy.ts for the gateway (the
// platform image does not ship convex/). runner/shared/pod-ip.test.mjs keeps
// the two in agreement.

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6 = /^[0-9a-f:]{2,39}$/i;

/**
 * A pod IP the gateway may proxy to: a syntactically valid IPv4/IPv6 address
 * that is not loopback, link-local or unspecified. Whatever the dispatcher
 * records as `podIp` becomes an upstream for every request on that route, so
 * both the writer (sessions.updateRunnerMetadata) and the reader (the gateway)
 * apply this check.
 */
export function isAllowedPodIp(value) {
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

function expandIpv6(value) {
  const [head, tail = ""] = value.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  const missing = 8 - headParts.length - tailParts.length;
  const parts = [...headParts, ...Array(Math.max(missing, 0)).fill("0"), ...tailParts];
  return parts.map((part) => part.padStart(4, "0").toLowerCase()).join(":");
}
