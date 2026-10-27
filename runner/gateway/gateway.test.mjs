import assert from "node:assert/strict"
import { createServer, request as httpRequest } from "node:http"
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import test from "node:test"
import { createGateway, parseEndpointHost, platformCookie, stripPlatformCookie } from "./gateway.mjs"
import { loadPtyBackend } from "../session-agent/pty.mjs"
import { loadScenario } from "../session-agent/scenario.mjs"
import { createAgent } from "../session-agent/server.mjs"

const quiet = { info() {}, warn() {}, error() {} }
const SUFFIX = "lab.localhost"
const APP_ORIGIN = "http://app.lab.localhost:8080"
const ROUTE = "abcdefghij0123456789abcd"
const CODE = "c".repeat(64)
const VERIFIER = "d".repeat(64)

/** In-memory Convex: one session with one unconsumed workspace+preview code each. */
function fakeConvex({ usable = true } = {}) {
  const codes = new Map([[`workspace:${CODE}`, { consumed: false }], [`preview:${"e".repeat(64)}`, { consumed: false }]])
  const grants = new Map()
  let counter = 0
  const route = { sessionId: "s1", status: "running", usable, podIp: "127.0.0.1", agentPort: 0, previewPort: 0 }
  return {
    route,
    grants,
    calls: { checkGrant: 0, resolveRoute: 0, consumeBootstrap: 0 },
    addCode(scope, code) {
      codes.set(`${scope}:${code}`, { consumed: false })
    },
    async mutation(path, args) {
      if (path === "workspaceAccess:consumeBootstrap") {
        this.calls.consumeBootstrap += 1
        const entry = codes.get(`${args.scope}:${args.code}`)
        if (!entry) return { ok: false, reason: "unknown" }
        if (entry.consumed) return { ok: false, reason: "consumed" }
        if (args.routeId !== ROUTE) return { ok: false, reason: "route-mismatch" }
        entry.consumed = true
        const grantId = `grant${++counter}abcdefghij`
        grants.set(grantId, { verifier: VERIFIER, scope: args.scope, routeId: ROUTE, status: "active" })
        return { ok: true, grantId, verifier: VERIFIER, sessionId: "s1", expiresAt: Date.now() + 60_000 }
      }
      if (path === "workspaceAccess:revokeGrant") {
        const grant = grants.get(args.grantId)
        if (grant) grant.status = "revoked"
        return Boolean(grant)
      }
      throw new Error(`unexpected mutation ${path}`)
    },
    async query(path, args) {
      if (path === "workspaceAccess:checkGrant") {
        this.calls.checkGrant += 1
        const grant = grants.get(args.grantId)
        if (!grant || grant.verifier !== args.verifier) return { ok: false, reason: "unknown" }
        if (grant.status !== "active") return { ok: false, reason: grant.status }
        if (grant.routeId !== args.routeId) return { ok: false, reason: "route-mismatch" }
        if (grant.scope !== args.scope) return { ok: false, reason: "scope-mismatch" }
        return { ok: true, sessionId: "s1", expiresAt: grant.expiresAt ?? Date.now() + 60_000 }
      }
      if (path === "workspaceAccess:resolveRoute") {
        this.calls.resolveRoute += 1
        return args.routeId === ROUTE ? { ...route, expiresAt: route.expiresAt ?? Date.now() + 60_000 } : null
      }
      throw new Error(`unexpected query ${path}`)
    },
  }
}

/** fetch() refuses to override Host, so tests talk raw node:http. */
function call(base, path, { method = "GET", headers = {}, body } = {}) {
  const url = new URL(path, base)
  return new Promise((resolveCall, reject) => {
    const req = httpRequest({ host: url.hostname, port: url.port, path: url.pathname + url.search, method, headers }, (res) => {
      const chunks = []
      res.on("data", (chunk) => chunks.push(chunk))
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8")
        resolveCall({
          status: res.statusCode,
          headers: res.headers,
          text: () => text,
          json: () => JSON.parse(text),
          setCookies: () => (Array.isArray(res.headers["set-cookie"]) ? res.headers["set-cookie"] : res.headers["set-cookie"] ? [res.headers["set-cookie"]] : []),
        })
      })
    })
    req.on("error", reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

async function listen(server) {
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen))
  return server.address().port
}

/** Upstream that echoes the request headers it received. */
async function echoUpstream() {
  const server = createServer((req, res) => {
    res.writeHead(200, {
      "content-type": "application/json",
      "set-cookie": ["app=1; Path=/", "evil=1; Domain=lab.localhost", "__Host-llp=stolen; Path=/"],
      "x-llp-internal": "leak",
    })
    res.end(JSON.stringify({ url: req.url, headers: req.headers }))
  })
  const port = await listen(server)
  return { port, close: () => new Promise((r) => server.close(r)) }
}

async function startGateway(convex, overrides = {}, now = undefined) {
  const gateway = createGateway({
    convex,
    config: { hostSuffix: SUFFIX, appOrigin: APP_ORIGIN, secureCookies: false, devPage: true, unsafeAllowLoopbackUpstream: true, ...overrides },
    logger: quiet,
    ...(now ? { now } : {}),
  })
  const port = await listen(gateway.server)
  const base = `http://127.0.0.1:${port}`
  const wsHost = `ws-${ROUTE}.${SUFFIX}:${port}`
  const pvHost = `pv-${ROUTE}.${SUFFIX}:${port}`
  return { gateway, port, base, wsHost, pvHost, close: () => new Promise((r) => gateway.server.close(r)) }
}

async function bootstrap(gw, { host = gw.wsHost, code = CODE, origin = APP_ORIGIN } = {}) {
  const response = await call(gw.base, "/__llp/bootstrap", {
    method: "POST",
    headers: { host, origin, "content-type": "application/json" },
    body: JSON.stringify({ code }),
  })
  const cookie = response.setCookies()[0]?.split(";")[0]
  return { response, cookie }
}

test("host parsing and cookie helpers", () => {
  assert.deepEqual(parseEndpointHost(`WS-${ROUTE}.${SUFFIX}:8080`, SUFFIX), { scope: "workspace", routeId: ROUTE })
  assert.equal(parseEndpointHost(`app.${SUFFIX}`, SUFFIX), null)
  assert.equal(parseEndpointHost(`ws-${ROUTE}.${SUFFIX}.evil`, SUFFIX), null)
  assert.deepEqual(platformCookie("a=1; llp=x.y; b=2", "llp"), { value: "x.y", count: 1 })
  assert.equal(platformCookie("a=1", "llp"), null)
  assert.equal(platformCookie("llp=1; llp=2", "llp").count, 2)
  assert.equal(stripPlatformCookie("a=1; llp=x.y; b=2", "llp"), "a=1; b=2")
  assert.equal(stripPlatformCookie("llp=x.y", "llp"), undefined)
})

test("bootstrap sets a host-only cookie; requests are proxied with credentials stripped", async () => {
  const upstream = await echoUpstream()
  const convex = fakeConvex()
  convex.route.agentPort = upstream.port
  const gw = await startGateway(convex)
  try {
    assert.equal((await call(gw.base, "/__llp/health")).status, 200)
    assert.deepEqual(Object.keys((await call(gw.base, "/__llp/health", { headers: { host: gw.wsHost } })).json()), ["ok"], "no stats on endpoint hosts")
    assert.ok((await call(gw.base, "/__llp/health", { headers: { host: `app.${SUFFIX}:8080` } })).json().stats, "stats on the app host")
    assert.equal((await call(gw.base, "/ready", { headers: { host: gw.wsHost } })).status, 401, "no cookie")

    const { response, cookie } = await bootstrap(gw)
    assert.equal(response.status, 204)
    assert.match(response.setCookies()[0], /^llp=grant1abcdefghij\.d{64}; Path=\/; HttpOnly; SameSite=Lax$/)
    assert.equal((await bootstrap(gw)).response.status, 401, "codes are single use")
    assert.equal((await bootstrap(gw, { origin: "http://evil.example" })).response.status, 403, "origin checked")

    const proxied = await call(gw.base, "/state?x=1", {
      headers: { host: gw.wsHost, cookie: `${cookie}; app=keep`, authorization: "Bearer leak", "x-forwarded-for": "1.2.3.4", "x-llp-scope": "preview" },
    })
    assert.equal(proxied.status, 200)
    const seen = proxied.json()
    assert.equal(seen.url, "/state?x=1")
    assert.equal(seen.headers.cookie, "app=keep")
    assert.equal(seen.headers.authorization, undefined)
    assert.equal(seen.headers["x-forwarded-for"], undefined)
    assert.equal(seen.headers["x-llp-scope"], "workspace")
    assert.equal(seen.headers["x-forwarded-host"], gw.wsHost)
    assert.deepEqual(proxied.setCookies(), ["app=1; Path=/"], "domain and platform cookies from the pod are dropped")
    assert.equal(proxied.headers["x-llp-internal"], undefined)
    assert.match(proxied.headers["content-security-policy"], /frame-ancestors 'self' http:\/\/app\.lab\.localhost:8080/)

    // Same cookie on the preview host: different scope → forbidden.
    assert.equal((await call(gw.base, "/", { headers: { host: gw.pvHost, cookie } })).status, 403)
    // Grant checks are cached.
    const before = convex.calls.checkGrant
    await call(gw.base, "/state", { headers: { host: gw.wsHost, cookie } })
    await call(gw.base, "/state", { headers: { host: gw.wsHost, cookie } })
    assert.equal(convex.calls.checkGrant, before)

    // Logout revokes.
    assert.equal((await call(gw.base, "/__llp/logout", { method: "POST", headers: { host: gw.wsHost, cookie } })).status, 403, "logout needs the app origin")
    const logout = await call(gw.base, "/__llp/logout", { method: "POST", headers: { host: gw.wsHost, cookie, origin: APP_ORIGIN } })
    assert.equal(logout.status, 204)
    assert.match(logout.setCookies()[0], /Max-Age=0/)
    assert.equal((await call(gw.base, "/state", { headers: { host: gw.wsHost, cookie } })).status, 401)

    assert.equal((await call(gw.base, "/anything", { headers: { host: `other.${SUFFIX}` } })).status, 404)
    assert.equal((await call(gw.base, "/", { headers: { host: gw.wsHost, cookie: `${cookie}; ${cookie}` } })).status, 400, "ambiguous cookie")
  } finally {
    await gw.close()
    await upstream.close()
  }
})

test("a session that is not running answers 503 after a valid grant", async () => {
  const convex = fakeConvex({ usable: false })
  const gw = await startGateway(convex)
  try {
    const { cookie } = await bootstrap(gw)
    const response = await call(gw.base, "/ready", { headers: { host: gw.wsHost, cookie } })
    assert.equal(response.status, 503)
    assert.equal(response.headers["retry-after"], "3")
  } finally {
    await gw.close()
  }
})

test("terminal WebSocket reaches the real agent through the gateway, and origin rules apply", async () => {
  const repoRoot = new URL("../../", import.meta.url).pathname
  const root = await mkdtemp(resolve(tmpdir(), "llp-gw-"))
  const scenarioDir = resolve(root, "scenario")
  await cp(resolve(repoRoot, "scenarios/git/first-commit"), scenarioDir, { recursive: true })
  const manifest = JSON.parse(await readFile(resolve(scenarioDir, "manifest.json"), "utf8"))
  manifest.workspace.cwd = resolve(root, "workspace")
  await writeFile(resolve(scenarioDir, "manifest.json"), JSON.stringify(manifest))
  const previousHome = process.env.HOME
  process.env.HOME = resolve(root, "home")
  process.env.AGENT_ALLOWED_WORKSPACE_ROOTS = `/workspace,/home,/tmp,${tmpdir()}`

  const agent = createAgent({
    scenario: await loadScenario(scenarioDir),
    backend: await loadPtyBackend({ logger: quiet }),
    reporter: { enabled: false, recordStepResult: async () => ({ reported: false }) },
    logger: quiet,
    devPage: false,
  })
  const agentPort = await listen(agent.server)
  await agent.start()
  await agent.settled()

  const convex = fakeConvex()
  convex.route.agentPort = agentPort
  const gw = await startGateway(convex)
  try {
    const { cookie } = await bootstrap(gw)
    const ready = await call(gw.base, "/ready", { headers: { host: gw.wsHost, cookie } })
    assert.equal(ready.status, 200)
    assert.equal(ready.json().scenario.slug, "first-commit")

    const dev = await call(gw.base, "/__llp/dev", { headers: { host: gw.wsHost, cookie } })
    assert.equal(dev.status, 200)
    assert.match(dev.headers["content-type"], /text\/html/)

    // Node's WebSocket cannot set Host/Cookie; drive the upgrade over a raw socket.
    const { connect } = await import("node:net")
    const output = await new Promise((resolveOut, reject) => {
      const socket = connect(gw.port, "127.0.0.1")
      let data = Buffer.alloc(0)
      socket.on("connect", () => {
        socket.write(
          `GET /pty?id=gw&cols=80&rows=24 HTTP/1.1\r\nHost: ${gw.wsHost}\r\nCookie: ${cookie}\r\nOrigin: ${APP_ORIGIN}\r\n` +
            "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
        )
      })
      socket.on("data", (chunk) => {
        data = Buffer.concat([data, chunk])
        if (data.includes("101 Switching Protocols") && !socket.sentInput) {
          socket.sentInput = true
          // masked text frame: "echo gw-$((40+2))\n"
          const payload = Buffer.from("echo gw-$((40+2))\n")
          const mask = Buffer.from([1, 2, 3, 4])
          const frame = Buffer.alloc(2 + 4 + payload.length)
          frame[0] = 0x81
          frame[1] = 0x80 | payload.length
          mask.copy(frame, 2)
          for (let i = 0; i < payload.length; i += 1) frame[6 + i] = payload[i] ^ mask[i % 4]
          socket.write(frame)
          setTimeout(() => socket.end(), 800)
        }
      })
      socket.on("close", () => resolveOut(data.toString("latin1")))
      socket.on("error", reject)
    })
    assert.match(output, /101 Switching Protocols/)
    assert.match(output, /gw-42/)

    const denied = await new Promise((resolveOut, reject) => {
      const socket = connect(gw.port, "127.0.0.1")
      let data = ""
      socket.on("connect", () =>
        socket.write(
          `GET /pty HTTP/1.1\r\nHost: ${gw.wsHost}\r\nCookie: ${cookie}\r\nOrigin: http://evil.example\r\n` +
            "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
        ),
      )
      socket.on("data", (chunk) => (data += chunk))
      socket.on("close", () => resolveOut(data))
      socket.on("error", reject)
    })
    assert.match(denied, /^HTTP\/1\.1 403/)
  } finally {
    await gw.close()
    agent.shutdown()
    process.env.HOME = previousHome
    delete process.env.AGENT_ALLOWED_WORKSPACE_ROOTS
    await rm(root, { recursive: true, force: true })
  }
})

test("state-changing proxied requests need an allowed Origin; unsafe methods without a browser signal pass", async () => {
  const upstream = await echoUpstream()
  const convex = fakeConvex()
  convex.route.agentPort = upstream.port
  convex.route.previewPort = upstream.port
  const gw = await startGateway(convex)
  try {
    const { cookie } = await bootstrap(gw)
    const post = (headers) => call(gw.base, "/steps/1/verify", { method: "POST", headers: { host: gw.wsHost, cookie, ...headers } })
    assert.equal((await post({ origin: `http://pv-${ROUTE}.${SUFFIX}:${gw.port}` })).status, 403, "preview origin cannot drive the workspace")
    assert.equal((await post({ origin: "http://evil.example" })).status, 403)
    assert.equal((await post({ "sec-fetch-site": "cross-site" })).status, 403, "browser without Origin is refused")
    assert.equal((await post({ origin: APP_ORIGIN })).status, 200, "app origin")
    assert.equal((await post({ origin: `http://${gw.wsHost}` })).status, 200, "own origin")
    assert.equal((await post({})).status, 200, "non-browser client (no Origin, no Sec-Fetch-Site)")
    assert.equal((await call(gw.base, "/state", { headers: { host: gw.wsHost, cookie, origin: "http://evil.example" } })).status, 200, "GET is not origin-gated")

    // Preview scope: only its own origin.
    const { cookie: previewCookie } = await bootstrap(gw, { host: gw.pvHost, code: "e".repeat(64) })
    const previewPost = (origin) => call(gw.base, "/x", { method: "POST", headers: { host: gw.pvHost, cookie: previewCookie, origin } })
    assert.equal((await previewPost(APP_ORIGIN)).status, 403)
    assert.equal((await previewPost(`http://${gw.pvHost}`)).status, 200)
  } finally {
    await gw.close()
    await upstream.close()
  }
})

test("bootstrap failures are limited per route and globally; wrong origins do not count", async () => {
  const convex = fakeConvex()
  let clock = Date.now()
  const gw = await startGateway(convex, {}, () => clock)
  try {
    for (let i = 0; i < 25; i += 1) assert.equal((await bootstrap(gw, { code: "0".repeat(64), origin: "http://evil.example" })).response.status, 403)
    assert.equal(convex.calls.consumeBootstrap, 0, "wrong-origin requests never reach Convex")
    for (let i = 0; i < 20; i += 1) assert.equal((await bootstrap(gw, { code: "0".repeat(64) })).response.status, 401)
    assert.equal((await bootstrap(gw)).response.status, 429, "the route is locked after 20 failures")
    clock += 61_000
    assert.equal((await bootstrap(gw)).response.status, 204, "the window passes")
  } finally {
    await gw.close()
  }
})

test("devPage is refused with secure cookies, and ?code= refuses cross-site navigations", async () => {
  assert.throws(() => createGateway({ convex: fakeConvex(), config: { hostSuffix: SUFFIX, appOrigin: APP_ORIGIN, devPage: true }, logger: quiet }), /GATEWAY_SECURE_COOKIES=false/)
  const convex = fakeConvex()
  const gw = await startGateway(convex)
  try {
    const cross = await call(gw.base, `/__llp/dev?code=${CODE}`, { headers: { host: gw.wsHost, "sec-fetch-site": "cross-site" } })
    assert.equal(cross.status, 403)
    assert.equal(convex.calls.consumeBootstrap, 0)
    const typed = await call(gw.base, `/__llp/dev?code=${CODE}`, { headers: { host: gw.wsHost, "sec-fetch-site": "none" } })
    assert.equal(typed.status, 303)
    assert.match(typed.setCookies()[0], /^llp=grant1abcdefghij\./)
  } finally {
    await gw.close()
  }
})

test("the app upstream only answers the app host, with the original Host kept and credentials stripped", async () => {
  const upstream = await echoUpstream()
  const gw = await startGateway(fakeConvex(), { appUpstream: { host: "127.0.0.1", port: upstream.port } })
  try {
    const appHost = `app.${SUFFIX}:8080`
    const seen = await call(gw.base, "/index.html", { headers: { host: appHost, authorization: "Bearer leak", cookie: "llp=grant.x; theme=dark" } })
    assert.equal(seen.status, 200)
    assert.equal(seen.json().headers.host, appHost, "Vite's allowedHosts sees the app host, not the upstream address")
    assert.equal(seen.json().headers.authorization, undefined)
    assert.equal(seen.json().headers.cookie, "theme=dark")
    assert.equal((await call(gw.base, "/index.html", { headers: { host: "host.docker.internal:5174" } })).status, 404)
    assert.equal((await call(gw.base, "/index.html", { headers: { host: `other.${SUFFIX}` } })).status, 404)
    assert.equal((await call(gw.base, "/index.html", {})).status, 404, "no app host, no app")
  } finally {
    await gw.close()
    await upstream.close()
  }
})

test("grant caches never outlive the grant, and a revoked grant cuts live sockets", async () => {
  const upstream = await echoUpstream()
  const convex = fakeConvex()
  convex.route.agentPort = upstream.port
  let clock = Date.now()
  const gw = await startGateway(convex, { grantSweepMs: 50 }, () => clock)
  try {
    const { cookie } = await bootstrap(gw)
    const grant = convex.grants.get("grant1abcdefghij")
    grant.expiresAt = clock + 1500
    assert.equal((await call(gw.base, "/state", { headers: { host: gw.wsHost, cookie } })).status, 200)
    const checks = convex.calls.checkGrant
    clock += 1000
    await call(gw.base, "/state", { headers: { host: gw.wsHost, cookie } })
    assert.equal(convex.calls.checkGrant, checks, "within TTL and expiry: cached")
    clock += 600 // past the grant's expiry but within the 5 s TTL → re-checked
    await call(gw.base, "/state", { headers: { host: gw.wsHost, cookie } })
    assert.equal(convex.calls.checkGrant, checks + 1)

    // A proxied, kept-alive connection is destroyed when the grant is revoked out of band.
    const { connect } = await import("node:net")
    const socket = connect(gw.port, "127.0.0.1")
    await new Promise((r) => socket.once("connect", r))
    socket.write(`GET /state HTTP/1.1\r\nHost: ${gw.wsHost}\r\nCookie: ${cookie}\r\n\r\n`)
    await new Promise((r) => socket.once("data", r))
    assert.equal(socket.destroyed, false)
    grant.status = "revoked"
    const closed = new Promise((r) => socket.once("close", r))
    await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error("socket not closed within 1 s")), 1000))])
    assert.ok(gw.gateway.stats.revokedSockets >= 1)
  } finally {
    await gw.close()
    await upstream.close()
  }
})

test("logout closes the grant's open WebSocket within a second", async () => {
  // Upstream that accepts any upgrade and holds the socket open.
  const held = []
  const upstreamServer = createServer((_req, res) => res.end("ok"))
  upstreamServer.on("upgrade", (_req, socket) => {
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: x\r\n\r\n")
    held.push(socket)
  })
  const upstreamPort = await listen(upstreamServer)
  const convex = fakeConvex()
  convex.route.agentPort = upstreamPort
  const gw = await startGateway(convex)
  try {
    const { cookie } = await bootstrap(gw)
    const { connect } = await import("node:net")
    const socket = connect(gw.port, "127.0.0.1")
    await new Promise((r) => socket.once("connect", r))
    socket.write(
      `GET /pty?id=x HTTP/1.1\r\nHost: ${gw.wsHost}\r\nCookie: ${cookie}\r\nOrigin: ${APP_ORIGIN}\r\n` +
        "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
    )
    const first = await new Promise((r) => socket.once("data", (chunk) => r(chunk.toString())))
    assert.match(first, /101 Switching Protocols/)
    const closed = new Promise((r) => socket.once("close", r))
    const logout = await call(gw.base, "/__llp/logout", { method: "POST", headers: { host: gw.wsHost, cookie, origin: APP_ORIGIN } })
    assert.equal(logout.status, 204)
    await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error("WebSocket not closed within 1 s")), 1000))])
    assert.equal(gw.gateway.stats.revokedSockets, 1)
  } finally {
    await gw.close()
    for (const socket of held) socket.destroy()
    await new Promise((r) => upstreamServer.close(r))
  }
})

test("CORS: the app origin gets credentialed headers and a preflight; others get nothing", async () => {
  const upstream = await echoUpstream()
  const convex = fakeConvex()
  convex.route.agentPort = upstream.port
  const gw = await startGateway(convex)
  try {
    const preflight = await call(gw.base, "/__llp/bootstrap", {
      method: "OPTIONS",
      headers: { host: gw.wsHost, origin: APP_ORIGIN, "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
    })
    assert.equal(preflight.status, 204)
    assert.equal(preflight.headers["access-control-allow-origin"], APP_ORIGIN)
    assert.equal(preflight.headers["access-control-allow-credentials"], "true")
    assert.match(preflight.headers["access-control-allow-methods"], /POST/)
    assert.equal((await call(gw.base, "/ready", { method: "OPTIONS", headers: { host: gw.wsHost, origin: "http://evil.example" } })).status, 403)

    const { response, cookie } = await bootstrap(gw)
    assert.equal(response.headers["access-control-allow-origin"], APP_ORIGIN)
    const proxied = await call(gw.base, "/state", { headers: { host: gw.wsHost, cookie, origin: APP_ORIGIN } })
    assert.equal(proxied.status, 200)
    assert.equal(proxied.headers["access-control-allow-origin"], APP_ORIGIN)
    assert.equal(proxied.headers["access-control-allow-credentials"], "true")
    assert.match(proxied.headers.vary, /Origin/)
    const plain = await call(gw.base, "/state", { headers: { host: gw.wsHost, cookie } })
    assert.equal(plain.headers["access-control-allow-origin"], undefined)
    const denied = await call(gw.base, "/state", { headers: { host: gw.wsHost, cookie, origin: "http://evil.example" } })
    assert.equal(denied.headers["access-control-allow-origin"], undefined)
  } finally {
    await gw.close()
    await upstream.close()
  }
})
