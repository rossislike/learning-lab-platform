// The session gateway (ADR 0003/0004): the only way into a session pod.
//
// Hosts:   ws-<routeId>.<suffix>  → pod:agentPort   (terminals, steps, /editor)
//          pv-<routeId>.<suffix>  → pod:previewPort (Vite preview)
//          anything else          → the app upstream when configured, else 404
//
// Reserved paths (never proxied):
//   GET  /__llp/health                        liveness, any host ({ok} only on endpoint hosts)
//   POST /__llp/bootstrap  {code}             consume a one-time code, set the cookie (Origin = app)
//   POST /__llp/logout                        revoke the cookie's grant (Origin = app)
//   GET  /__llp/dev[?code=…]                  dev terminal page (ws hosts, devPage only, plain http only);
//                                             with ?code it consumes the code first (dev only — ADR 0004
//                                             forbids codes in URLs in production, where devPage is off)
//
// Every other request and WebSocket upgrade on an endpoint host needs the
// host-only cookie `<cookieName>=<grantId>.<verifier>`; the grant is checked
// with Convex (cached ≤ 5 s, never past its expiry), the route resolved
// (cached the same way), platform credentials stripped, and the request
// proxied to the pod. State-changing requests and upgrades must carry an
// allowed Origin (or none at all, for non-browser clients). Proxied sockets
// are tracked per grant and destroyed when the grant is revoked (logout, or
// the 5 s re-validation sweep).

import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { proxyHttp, proxyUpgrade } from "../shared/proxy.mjs"
import { isAllowedPodIp } from "../shared/pod-ip.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEV_PAGE = resolve(__dirname, "../session-agent/public/terminal.html")
const CACHE_TTL_MS = 5000
const CACHE_MAX = 2000
const BOOTSTRAP_BODY_LIMIT = 4096
const BOOTSTRAP_FAILURE_LIMIT = 20 // per route per minute (addresses are shared behind NAT/ALB)
const BOOTSTRAP_GLOBAL_FAILURE_LIMIT = 200 // across all routes per minute
const GRANT_SWEEP_MS = 5000
const DENIED_GRANT_CACHE_TTL_MS = 1000
const BOOTSTRAP_FAILURE_WINDOW_MS = 60_000
const BOOTSTRAP_FAILURE_MAP_MAX = 10_000
const GLOBAL_FAILURE_KEY = "*"
const HEADERS_TIMEOUT_MS = 30_000
const REQUEST_TIMEOUT_MS = 600_000
const PREFLIGHT_MAX_AGE_SECONDS = "600"
const NOT_RUNNING_RETRY_AFTER_SECONDS = "3"
const RESERVED_PREFIX = "/__llp/"
const HEALTH_PATH = "/__llp/health"
const BOOTSTRAP_PATH = "/__llp/bootstrap"
const LOGOUT_PATH = "/__llp/logout"
const DEV_PATH = "/__llp/dev"
const PLATFORM_HEADER_PREFIX = "x-llp-"
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])
const SAME_SITE_NAVIGATION = new Set(["none", "same-site", "same-origin"])
const ROUTE_ID = /^[a-z0-9]{20,32}$/
const GRANT_ID = /^[a-z0-9]{10,64}$/
const VERIFIER = /^[0-9a-f]{64}$/
const STRIPPED_REQUEST_HEADERS = new Set([
  "authorization",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-real-ip",
])

export function parseEndpointHost(hostHeader, suffix) {
  if (!hostHeader) return null
  const host = String(hostHeader).toLowerCase().replace(/:\d+$/, "")
  const tail = `.${suffix.toLowerCase()}`
  if (!host.endsWith(tail)) return null
  const match = host.slice(0, -tail.length).match(/^(ws|pv)-([a-z0-9]+)$/)
  if (!match || !ROUTE_ID.test(match[2])) return null
  return { scope: match[1] === "ws" ? "workspace" : "preview", routeId: match[2] }
}

/** Returns { value, count } for the platform cookie, or null; count > 1 means ambiguous. */
export function platformCookie(cookieHeader, name) {
  if (!cookieHeader) return null
  const found = []
  for (const part of String(cookieHeader).split(";")) {
    const index = part.indexOf("=")
    if (index === -1) continue
    if (part.slice(0, index).trim() === name) found.push(part.slice(index + 1).trim())
  }
  return found.length ? { value: found[0], count: found.length } : null
}

/** The Cookie header without the platform cookie (other cookies pass through). */
export function stripPlatformCookie(cookieHeader, name) {
  if (!cookieHeader) return undefined
  const kept = String(cookieHeader)
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && part.slice(0, part.indexOf("=") === -1 ? undefined : part.indexOf("=")).trim() !== name)
  return kept.length ? kept.join("; ") : undefined
}

function parseGrantCookie(value) {
  const dot = value.indexOf(".")
  if (dot === -1) return null
  const grantId = value.slice(0, dot)
  const verifier = value.slice(dot + 1)
  if (!GRANT_ID.test(grantId) || !VERIFIER.test(verifier)) return null
  return { grantId, verifier }
}

function createCache(now) {
  const map = new Map()
  return {
    get(key) {
      const entry = map.get(key)
      if (!entry) return undefined
      if (entry.expiresAt <= now()) {
        map.delete(key)
        return undefined
      }
      return entry.value
    },
    set(key, value, ttlMs = CACHE_TTL_MS) {
      if (map.size >= CACHE_MAX) map.delete(map.keys().next().value)
      map.set(key, { value, expiresAt: now() + ttlMs })
    },
    delete(key) {
      map.delete(key)
    },
  }
}

function json(res, status, body, extra = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    ...extra,
  })
  res.end(JSON.stringify(body))
}

function readJsonBody(req, limit) {
  return new Promise((resolveBody, reject) => {
    let size = 0
    const chunks = []
    req.on("data", (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error("body too large"))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"))
      } catch {
        reject(new Error("invalid json"))
      }
    })
    req.on("error", reject)
  })
}

function parseRequestUrl(req) {
  try {
    return new URL(req.url, "http://gateway")
  } catch {
    return null
  }
}

export function createGateway({ convex, config, logger = console, now = () => Date.now() }) {
  if (config.devPage && config.secureCookies !== false) {
    throw new Error(
      "GATEWAY_DEV_PAGE=true is only allowed with GATEWAY_SECURE_COOKIES=false (plain-http local development): /__llp/dev?code= puts bootstrap codes in URLs, which ADR 0004 forbids outside local",
    )
  }
  const scheme = config.secureCookies === false ? "http" : "https"
  const cookieName = config.cookieName ?? (config.secureCookies === false ? "llp" : "__Host-llp")
  const appHost = config.appOrigin ? new URL(config.appOrigin).host.toLowerCase() : null
  const grantCache = createCache(now)
  const routeCache = createCache(now)
  const bootstrapFailures = new Map() // routeId (or GLOBAL_FAILURE_KEY) → { count, windowStart }
  const grantSockets = new Map() // grant key → Set<socket> of live proxied connections
  const stats = { requests: 0, upgrades: 0, bootstraps: 0, denied: 0, revokedSockets: 0 }

  function isAppHost(hostHeader) {
    return Boolean(appHost) && String(hostHeader ?? "").toLowerCase() === appHost
  }

  function ownOrigin(req) {
    return `${scheme}://${String(req.headers.host).toLowerCase()}`
  }

  /** TTL for a cached grant/route: at most 5 s, never past the record's own expiry. */
  function cacheTtl(expiresAt) {
    if (typeof expiresAt !== "number") return CACHE_TTL_MS
    return Math.max(0, Math.min(CACHE_TTL_MS, expiresAt - now()))
  }

  function grantKey(endpoint, cookieValue) {
    return `${endpoint.scope}:${endpoint.routeId}:${cookieValue}`
  }

  function trackSocket(key, socket) {
    let set = grantSockets.get(key)
    if (!set) grantSockets.set(key, (set = new Set()))
    set.add(socket)
    socket.once("close", () => {
      set.delete(socket)
      if (set.size === 0 && grantSockets.get(key) === set) grantSockets.delete(key)
    })
  }

  function destroyGrantSockets(key, { except } = {}) {
    const set = grantSockets.get(key)
    if (!set) return 0
    grantSockets.delete(key)
    let destroyed = 0
    for (const socket of set) {
      if (socket === except) continue // the logout request's own keep-alive connection; closed after its response
      stats.revokedSockets += 1
      destroyed += 1
      socket.destroy()
    }
    return destroyed
  }

  /** Every 5 s, re-check each grant that still has live sockets; cut the ones no longer valid. */
  async function sweepGrants() {
    for (const key of [...grantSockets.keys()]) {
      const [scope, routeId, cookieValue] = key.split(":")
      const parsed = parseGrantCookie(cookieValue)
      if (!parsed) {
        destroyGrantSockets(key)
        continue
      }
      try {
        const result = await checkGrant({ scope, routeId }, parsed, cookieValue)
        if (!result.ok) destroyGrantSockets(key)
      } catch (error) {
        logger.warn?.(`[gateway] grant sweep: ${error.message}`)
      }
    }
  }

  function cookieHeader(value, { clear = false } = {}) {
    const attrs = [`${cookieName}=${clear ? "" : value}`, "Path=/", "HttpOnly", "SameSite=Lax"]
    if (config.secureCookies !== false) attrs.push("Secure")
    if (clear) attrs.push("Max-Age=0")
    return attrs.join("; ")
  }

  function grantCookieFor(grant) {
    return cookieHeader(`${grant.grantId}.${grant.verifier}`)
  }

  function failureWindow(key) {
    const entry = bootstrapFailures.get(key)
    if (!entry) return null
    if (now() - entry.windowStart > BOOTSTRAP_FAILURE_WINDOW_MS) {
      bootstrapFailures.delete(key)
      return null
    }
    return entry
  }

  /** Failures are counted per route (the thing being guessed at) and globally, not per client address. */
  function bootstrapRateLimited(routeId) {
    const perRoute = failureWindow(routeId)
    const global = failureWindow(GLOBAL_FAILURE_KEY)
    return Boolean((perRoute && perRoute.count >= BOOTSTRAP_FAILURE_LIMIT) || (global && global.count >= BOOTSTRAP_GLOBAL_FAILURE_LIMIT))
  }

  function recordBootstrapFailure(routeId) {
    for (const key of [routeId, GLOBAL_FAILURE_KEY]) {
      const entry = failureWindow(key)
      if (!entry) bootstrapFailures.set(key, { count: 1, windowStart: now() })
      else entry.count += 1
    }
    if (bootstrapFailures.size > BOOTSTRAP_FAILURE_MAP_MAX) bootstrapFailures.clear()
  }

  async function checkGrant(endpoint, parsed, cookieValue) {
    const key = grantKey(endpoint, cookieValue)
    let result = grantCache.get(key)
    if (!result) {
      result = await convex.query("workspaceAccess:checkGrant", {
        grantId: parsed.grantId,
        verifier: parsed.verifier,
        routeId: endpoint.routeId,
        scope: endpoint.scope,
      })
      grantCache.set(key, result, result.ok ? cacheTtl(result.expiresAt) : DENIED_GRANT_CACHE_TTL_MS)
    }
    return result
  }

  async function authorize(req, endpoint) {
    const cookie = platformCookie(req.headers.cookie, cookieName)
    if (!cookie) return { status: 401, reason: "no-cookie" }
    if (cookie.count > 1) return { status: 400, reason: "ambiguous-cookie" }
    const parsed = parseGrantCookie(cookie.value)
    if (!parsed) return { status: 401, reason: "malformed-cookie" }
    const result = await checkGrant(endpoint, parsed, cookie.value)
    if (!result.ok) {
      const forbidden = ["route-mismatch", "scope-mismatch"].includes(result.reason)
      return { status: forbidden ? 403 : 401, reason: result.reason, grantId: parsed.grantId }
    }
    return { status: 200, sessionId: result.sessionId, grantId: parsed.grantId, key: grantKey(endpoint, cookie.value) }
  }

  async function resolveRoute(routeId) {
    let route = routeCache.get(routeId)
    if (route === undefined) {
      route = (await convex.query("workspaceAccess:resolveRoute", { routeId })) ?? null
      routeCache.set(routeId, route, cacheTtl(route?.expiresAt))
    }
    return route
  }

  function upstreamFor(route, scope) {
    // Loopback/link-local pod IPs are never proxied to (the gateway's own
    // pod, the node's metadata service). Tests opt in with
    // unsafeAllowLoopbackUpstream; main.mjs never sets it.
    const ipOk = isAllowedPodIp(route?.podIp) || (config.unsafeAllowLoopbackUpstream === true && /^127\./.test(String(route?.podIp)))
    if (!route?.usable || !ipOk) return null
    const port = scope === "workspace" ? route.agentPort : route.previewPort
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
    return { host: route.podIp, port }
  }

  function requestRewrite(req, endpoint) {
    return (headers) => {
      for (const name of Object.keys(headers)) {
        if (STRIPPED_REQUEST_HEADERS.has(name) || name.startsWith(PLATFORM_HEADER_PREFIX)) delete headers[name]
      }
      const cookies = stripPlatformCookie(headers.cookie, cookieName)
      if (cookies) headers.cookie = cookies
      else delete headers.cookie
      headers["x-forwarded-host"] = req.headers.host
      headers["x-forwarded-proto"] = scheme
      headers["x-llp-scope"] = endpoint.scope
      return headers
    }
  }

  function responseRewrite() {
    return (headers) => {
      const setCookie = headers["set-cookie"]
      if (setCookie) {
        const kept = (Array.isArray(setCookie) ? setCookie : [setCookie]).filter((value) => {
          const name = value.split("=")[0].trim()
          return !/;\s*domain=/i.test(value) && name !== cookieName && !name.startsWith("__Host-")
        })
        if (kept.length) headers["set-cookie"] = kept
        else delete headers["set-cookie"]
      }
      for (const name of Object.keys(headers)) if (name.startsWith(PLATFORM_HEADER_PREFIX)) delete headers[name]
      headers["content-security-policy"] = `frame-ancestors 'self' ${config.appOrigin}`
      headers["referrer-policy"] = "no-referrer"
      return headers
    }
  }

  /**
   * Browser-originated requests must come from the app or from the endpoint's
   * own origin (workspace), or only from its own origin (preview). A request
   * with no Origin is accepted only when it is not from a browser at all
   * (no Sec-Fetch-Site either): the grant cookie is then the credential.
   */
  function originAllowed(req, endpoint) {
    const origin = req.headers.origin
    if (origin === undefined) return req.headers["sec-fetch-site"] === undefined
    const own = ownOrigin(req)
    if (endpoint.scope === "preview") return origin === own
    return origin === config.appOrigin || origin === own
  }

  async function handleBootstrap(req, res, endpoint) {
    // Wrong-Origin requests never reach the counters: a third party must not
    // be able to lock a route's owner out.
    if (req.headers.origin !== config.appOrigin) {
      stats.denied += 1
      return json(res, 403, { error: "origin not allowed" })
    }
    if (bootstrapRateLimited(endpoint.routeId)) return json(res, 429, { error: "too many attempts" })
    if (!/^application\/json/i.test(String(req.headers["content-type"]))) {
      return json(res, 415, { error: "application/json required" })
    }
    let body
    try {
      body = await readJsonBody(req, BOOTSTRAP_BODY_LIMIT)
    } catch (error) {
      return json(res, 400, { error: error.message })
    }
    const code = typeof body.code === "string" ? body.code : ""
    const grant = await consumeBootstrap(code, endpoint)
    if (!grant) return json(res, 401, { error: "bootstrap failed" })
    res.writeHead(204, {
      "set-cookie": grantCookieFor(grant),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    })
    return res.end()
  }

  /** Consumes a code; returns the grant or null (a rejection is logged by reason only, and counted). */
  async function consumeBootstrap(code, endpoint) {
    let result
    try {
      result = await convex.mutation("workspaceAccess:consumeBootstrap", { code, routeId: endpoint.routeId, scope: endpoint.scope })
    } catch (error) {
      result = { ok: false, reason: `error: ${error.message}` }
    }
    if (result?.ok && result.grantId && result.verifier) {
      stats.bootstraps += 1
      return result
    }
    recordBootstrapFailure(endpoint.routeId)
    stats.denied += 1
    logger.warn?.(`[gateway] bootstrap rejected for ${endpoint.scope} ${endpoint.routeId}: ${result?.reason ?? "unknown"}`)
    return null
  }

  async function handleLogout(req, res, endpoint) {
    if (req.headers.origin !== config.appOrigin) {
      stats.denied += 1
      return json(res, 403, { error: "origin not allowed" })
    }
    const cookie = platformCookie(req.headers.cookie, cookieName)
    const parsed = cookie && cookie.count === 1 ? parseGrantCookie(cookie.value) : null
    if (parsed) {
      await convex.mutation("workspaceAccess:revokeGrant", { grantId: parsed.grantId, reason: "logout" }).catch(() => {})
      const key = grantKey(endpoint, cookie.value)
      grantCache.delete(key)
      destroyGrantSockets(key, { except: req.socket })
    }
    res.writeHead(204, { "set-cookie": cookieHeader("", { clear: true }), "cache-control": "no-store", connection: "close" })
    res.end()
  }

  /**
   * The app upstream (Vite dev server locally) is reachable only under the
   * app's own Host: the original Host is kept so Vite's allowedHosts check
   * sees app.<suffix>, and platform credentials never reach it.
   */
  function appRewrite(req) {
    return (headers) => {
      headers.host = req.headers.host
      delete headers.authorization
      const cookies = stripPlatformCookie(headers.cookie, cookieName)
      if (cookies) headers.cookie = cookies
      else delete headers.cookie
      return headers
    }
  }

  function appUpstreamTarget(req) {
    return { host: config.appUpstream.host, port: config.appUpstream.port, rewriteRequestHeaders: appRewrite(req) }
  }

  /** Adds credentialed CORS headers for the app origin to every response on an endpoint host. */
  function applyCors(req, res) {
    if (req.headers.origin !== config.appOrigin) return
    const writeHead = res.writeHead.bind(res)
    res.writeHead = (status, headers = {}) => {
      const merged = { ...headers }
      // Upstream (pod) CORS decisions never reach the browser; ours do.
      for (const name of Object.keys(merged)) {
        if (/^access-control-allow-(origin|credentials)$/i.test(name)) delete merged[name]
      }
      merged["access-control-allow-origin"] = config.appOrigin
      merged["access-control-allow-credentials"] = "true"
      merged.vary = merged.vary ? `${merged.vary}, Origin` : "Origin"
      return writeHead(status, merged)
    }
  }

  /**
   * Everything a request or an upgrade on an endpoint host must pass before
   * it is proxied: an allowed Origin (when `originRequired`), a valid grant
   * cookie, and a running session to proxy to. Returns { ok, auth, upstream }
   * or a refusal { ok: false, status, message, statusText, retryAfter? }: the
   * HTTP status, the JSON error message, the upgrade status text, and (for
   * "not running" only) the Retry-After seconds. Only Origin and grant
   * refusals count as denied; "not running" is a transient 503 the client
   * retries.
   */
  async function admit(req, endpoint, { originRequired }) {
    if (originRequired && !originAllowed(req, endpoint)) {
      stats.denied += 1
      return { ok: false, status: 403, message: "origin not allowed", statusText: "Origin Not Allowed" }
    }
    const auth = await authorize(req, endpoint)
    if (auth.status !== 200) {
      stats.denied += 1
      const forbidden = auth.status === 403
      return {
        ok: false,
        status: auth.status,
        message: forbidden ? "forbidden" : "not authorized",
        statusText: forbidden ? "Forbidden" : "Unauthorized",
      }
    }
    const route = await resolveRoute(endpoint.routeId)
    const upstream = upstreamFor(route, endpoint.scope)
    if (!upstream) {
      return {
        ok: false,
        status: 503,
        message: "session is not running",
        statusText: "Session Not Running",
        retryAfter: NOT_RUNNING_RETRY_AFTER_SECONDS,
      }
    }
    return { ok: true, auth, upstream }
  }

  // --- HTTP ------------------------------------------------------------------

  async function handleRequest(req, res) {
    stats.requests += 1
    const url = parseRequestUrl(req)
    if (!url) return json(res, 400, { error: "malformed request target" })
    const endpoint = parseEndpointHost(req.headers.host, config.hostSuffix)
    if (url.pathname === HEALTH_PATH) return handleHealth(req, res, endpoint)
    if (!endpoint) return handleNonEndpointHost(req, res)
    // CORS for the app origin only (ADR 0004: exact origins, credentials
    // allowed, no wildcards). The frontend bootstraps, polls /ready and runs
    // step verification on the ws- host from app.<suffix>.
    applyCors(req, res)
    if (req.method === "OPTIONS") return handlePreflight(req, res)
    try {
      if (url.pathname.startsWith(RESERVED_PREFIX)) return await handleReservedPath(req, res, endpoint, url)
      return await proxyToSession(req, res, endpoint)
    } catch (error) {
      logger.error?.(`[gateway] ${req.method} ${req.headers.host}${url.pathname}: ${error.stack ?? error}`)
      if (!res.headersSent) json(res, 502, { error: "gateway error" })
      else res.destroy()
    }
  }

  /** Stats only for the operator-facing host; endpoint hosts answer {ok} alone. */
  function handleHealth(req, res, endpoint) {
    const withStats = !endpoint && (!req.headers.host || isAppHost(req.headers.host))
    return json(res, 200, withStats ? { ok: true, stats } : { ok: true })
  }

  function handleNonEndpointHost(req, res) {
    if (config.appUpstream && isAppHost(req.headers.host)) {
      return proxyHttp(req, res, appUpstreamTarget(req))
    }
    return json(res, 404, { error: "unknown host" })
  }

  function handlePreflight(req, res) {
    if (req.headers.origin !== config.appOrigin) return json(res, 403, { error: "origin not allowed" })
    res.writeHead(204, {
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": req.headers["access-control-request-headers"] ?? "content-type",
      "access-control-max-age": PREFLIGHT_MAX_AGE_SECONDS,
      "cache-control": "no-store",
    })
    return res.end()
  }

  function handleReservedPath(req, res, endpoint, url) {
    if (url.pathname === BOOTSTRAP_PATH && req.method === "POST") return handleBootstrap(req, res, endpoint)
    if (url.pathname === LOGOUT_PATH && req.method === "POST") return handleLogout(req, res, endpoint)
    if (url.pathname === DEV_PATH && config.devPage && endpoint.scope === "workspace") return handleDevPage(req, res, endpoint, url)
    return json(res, 404, { error: "not found" })
  }

  async function handleDevPage(req, res, endpoint, url) {
    const code = url.searchParams.get("code")
    if (code) return bootstrapFromDevUrl(req, res, endpoint, code)
    const auth = await authorize(req, endpoint)
    if (auth.status !== 200) return json(res, auth.status, { error: "not authorized" })
    const page = await readFile(DEV_PAGE)
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
    return res.end(page)
  }

  /**
   * A code in a URL must be the developer's own navigation (typed or pasted),
   * never a link from another site (session fixation).
   */
  async function bootstrapFromDevUrl(req, res, endpoint, code) {
    const site = req.headers["sec-fetch-site"]
    if (site !== undefined && !SAME_SITE_NAVIGATION.has(site)) {
      stats.denied += 1
      return json(res, 403, { error: "cross-site navigation not allowed" })
    }
    if (bootstrapRateLimited(endpoint.routeId)) return json(res, 429, { error: "too many attempts" })
    const grant = await consumeBootstrap(code, endpoint)
    if (!grant) return json(res, 401, { error: "bootstrap failed" })
    res.writeHead(303, { location: DEV_PATH, "set-cookie": grantCookieFor(grant), "cache-control": "no-store" })
    return res.end()
  }

  async function proxyToSession(req, res, endpoint) {
    const admission = await admit(req, endpoint, { originRequired: !SAFE_METHODS.has(req.method) })
    if (!admission.ok) {
      const extra = admission.retryAfter ? { "retry-after": admission.retryAfter } : {}
      return json(res, admission.status, { error: admission.message }, extra)
    }
    trackSocket(admission.auth.key, req.socket)
    return proxyHttp(req, res, {
      ...admission.upstream,
      rewriteRequestHeaders: requestRewrite(req, endpoint),
      rewriteResponseHeaders: responseRewrite(),
    })
  }

  // --- WebSocket upgrades ---------------------------------------------------

  function rejectUpgrade(socket, status, text) {
    if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  }

  async function handleUpgrade(req, socket, head) {
    stats.upgrades += 1
    socket.on("error", () => {})
    const endpoint = parseEndpointHost(req.headers.host, config.hostSuffix)
    if (!endpoint) return upgradeNonEndpointHost(req, socket, head)
    const url = parseRequestUrl(req)
    if (!url) return rejectUpgrade(socket, 400, "Bad Request")
    if (url.pathname.startsWith(RESERVED_PREFIX)) return rejectUpgrade(socket, 404, "Not Found")
    try {
      await upgradeToSession(req, socket, head, endpoint)
    } catch (error) {
      logger.error?.(`[gateway] upgrade ${req.headers.host}${url.pathname}: ${error.stack ?? error}`)
      rejectUpgrade(socket, 502, "Bad Gateway")
    }
  }

  function upgradeNonEndpointHost(req, socket, head) {
    if (config.appUpstream && isAppHost(req.headers.host)) {
      return proxyUpgrade(req, socket, head, appUpstreamTarget(req))
    }
    return rejectUpgrade(socket, 404, "Not Found")
  }

  async function upgradeToSession(req, socket, head, endpoint) {
    const admission = await admit(req, endpoint, { originRequired: true })
    if (!admission.ok) return rejectUpgrade(socket, admission.status, admission.statusText)
    trackSocket(admission.auth.key, socket)
    return proxyUpgrade(req, socket, head, { ...admission.upstream, rewriteRequestHeaders: requestRewrite(req, endpoint) })
  }

  const server = createServer(handleRequest)
  server.headersTimeout = HEADERS_TIMEOUT_MS
  server.requestTimeout = REQUEST_TIMEOUT_MS
  server.on("upgrade", handleUpgrade)
  server.on("clientError", (error, socket) => {
    if (error.code === "ECONNRESET" || !socket.writable) return socket.destroy()
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
  })
  let sweeping = false
  const sweep = setInterval(() => {
    if (sweeping || grantSockets.size === 0) return
    sweeping = true
    sweepGrants().finally(() => (sweeping = false))
  }, config.grantSweepMs ?? GRANT_SWEEP_MS)
  sweep.unref()
  server.once("close", () => {
    clearInterval(sweep)
    for (const key of [...grantSockets.keys()]) destroyGrantSockets(key)
  })
  return { server, stats, cookieName, sweepGrants }
}
