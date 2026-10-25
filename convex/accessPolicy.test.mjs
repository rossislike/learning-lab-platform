import assert from "node:assert/strict"
import test from "node:test"
import {
  bootstrapRejection,
  endpointHost,
  grantExpiry,
  grantRejection,
  isAllowedPodIp,
  parseEndpointHost,
} from "./accessPolicy.ts"

const routeId = "abcdefghij0123456789"

test("endpoint hosts round-trip through the parser and ignore ports and case", () => {
  assert.equal(endpointHost("workspace", routeId, "lab.localhost"), `ws-${routeId}.lab.localhost`)
  assert.deepEqual(parseEndpointHost(`WS-${routeId}.Lab.Localhost:8080`, "lab.localhost"), { scope: "workspace", routeId })
  assert.deepEqual(parseEndpointHost(`pv-${routeId}.lab.localhost`, "lab.localhost"), { scope: "preview", routeId })
})

test("foreign, malformed, and lookalike hosts are rejected", () => {
  assert.equal(parseEndpointHost(undefined, "lab.localhost"), null)
  assert.equal(parseEndpointHost("app.lab.localhost", "lab.localhost"), null)
  assert.equal(parseEndpointHost(`ws-${routeId}.lab.localhost.evil.com`, "lab.localhost"), null)
  assert.equal(parseEndpointHost(`ws-${routeId}.evil.com`, "lab.localhost"), null)
  assert.equal(parseEndpointHost(`ws-short.lab.localhost`, "lab.localhost"), null)
  assert.equal(parseEndpointHost(`ed-${routeId}.lab.localhost`, "lab.localhost"), null)
  assert.equal(parseEndpointHost(`ws-${routeId}.x.lab.localhost`, "lab.localhost"), null)
})

test("grant expiry never outlives the session or one hour", () => {
  const now = 1_000_000
  assert.equal(grantExpiry(now, now + 10_000), now + 10_000)
  assert.equal(grantExpiry(now, now + 10 * 60 * 60 * 1000), now + 60 * 60 * 1000)
})

test("bootstrap codes are single use, bound to route and scope, and need a usable session", () => {
  const now = 5000
  const record = { routeId, scope: "workspace", expiresAt: now + 1000 }
  const ok = { routeId, scope: "workspace", now, sessionUsable: true }
  assert.equal(bootstrapRejection(record, ok), null)
  assert.equal(bootstrapRejection(null, ok), "unknown")
  assert.equal(bootstrapRejection({ ...record, consumedAt: 1 }, ok), "consumed")
  assert.equal(bootstrapRejection(record, { ...ok, now: now + 2000 }), "expired")
  assert.equal(bootstrapRejection(record, { ...ok, routeId: "zzzzzzzzzzzzzzzzzzzz" }), "route-mismatch")
  assert.equal(bootstrapRejection(record, { ...ok, scope: "preview" }), "scope-mismatch")
  assert.equal(bootstrapRejection(record, { ...ok, sessionUsable: false }), "session-not-usable")
})

test("grants require a matching verifier, active status, expiry, route, scope, and usable session", () => {
  const now = 5000
  const record = { routeId, scope: "preview", status: "active", expiresAt: now + 1000 }
  const ok = { routeId, scope: "preview", now, sessionUsable: true, verifierMatches: true }
  assert.equal(grantRejection(record, ok), null)
  assert.equal(grantRejection(null, ok), "unknown")
  assert.equal(grantRejection(record, { ...ok, verifierMatches: false }), "verifier-mismatch")
  assert.equal(grantRejection({ ...record, status: "revoked" }, ok), "revoked")
  assert.equal(grantRejection(record, { ...ok, now: now + 5000 }), "expired")
  assert.equal(grantRejection(record, { ...ok, scope: "workspace" }), "scope-mismatch")
  assert.equal(grantRejection(record, { ...ok, sessionUsable: false }), "session-not-usable")
})

test("pod ips: routable unicast only; loopback, link-local and garbage rejected", () => {
  for (const ok of ["10.244.1.7", "172.18.0.5", "192.168.1.1", "8.8.8.8", "fd00::1", "2001:db8::7", "::ffff:a00:1"]) {
    assert.equal(isAllowedPodIp(ok), true, ok)
  }
  for (const bad of [
    "127.0.0.1", "127.1.2.3", "0.0.0.0", "169.254.169.254", "::1", "::", "fe80::1", "FE80::abcd",
    "::ffff:7f00:1", "::ffff:a9fe:a9fe", "::ffff:10.0.0.1", "10.0.0", "10.0.0.256", "localhost", "example.com",
    "10.0.0.1:7000", "", undefined, null, 42, "1:2:3:4:5:6:7:8:9", "1::2::3", "12345::1", "10.0.0.1\n",
  ]) {
    assert.equal(isAllowedPodIp(bad), false, String(bad))
  }
})
