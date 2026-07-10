# ADR 0004: Secure Per-Session URL Access

- Status: Accepted
- Date: 2026-07-09
- Decision owners: Learning Lab Platform maintainers

## Context

ADR 0003 assigns stable, opaque editor, preview, and tools hostnames to each hosted learner session and routes them through a shared session gateway. A route ID is intentionally not an authorization credential. Anyone who learns a workspace URL must still be denied unless they own the session or hold an explicit support grant.

The access mechanism must support normal HTTP requests, OpenVSCode and Vite WebSockets, dashboard iframes, multiple simultaneous sessions, prompt revocation, and hostile learner-authored preview code. It must not put bearer credentials in URLs, browser storage, Convex events, load balancer logs, or learner task processes.

## Decision

Enforce authentication and authorization at the session gateway with server-side opaque access grants and endpoint-host browser cookies.

The trusted product backend authenticates the user through the configured identity provider and authorizes access from Convex session ownership or an explicit support grant. The browser then exchanges endpoint-bound, one-time bootstrap codes at the editor, preview, and tools hosts. The gateway sets a host-only access cookie on each authorized endpoint.

```text
Authenticated dashboard
  -> authorize session owner or support role
  -> issue endpoint-bound, one-time bootstrap codes
  -> POST each code to its editor, preview, or tools host
  -> gateway consumes each code and sets a host-only cookie
  -> browser opens editor, preview, and tools hosts
  -> gateway validates cookie, route, scope, origin, and expiry
  -> gateway strips credentials and proxies to the private task
```

Local development keeps its current local-only behavior. Hosted and public modes cannot enable workspace links until the identity provider, access issuer, gateway validation, and owner-scoped Convex queries are active.

## Identity And Ownership

Hosted sessions must store an immutable authenticated owner subject from the configured identity provider. `learnerLabel` remains display metadata and cannot authorize access.

The trusted product backend may issue access only when one of these rules succeeds:

- the authenticated subject owns the session;
- an authenticated support or admin subject has an explicit, unexpired support grant for the session.

Authors and other learners receive no implicit access. Support grants require a reason, issuer subject, creation time, absolute expiry, and audit event. A support grant defaults to 15 minutes and cannot outlive the session.

All browser-facing Convex session, progress, event, and URL queries must apply the same ownership or support authorization. Hiding a URL in the dashboard is not an authorization boundary.

## Bootstrap Exchange

After authorization, the trusted backend creates a cryptographically random one-time bootstrap code for each authorized endpoint, with at least 256 bits of entropy per code. Convex stores only the SHA-256 hashes and these bound fields:

- route ID and session ID;
- authenticated subject;
- one allowed endpoint scope;
- owner or support role;
- issuer and support reason when applicable;
- creation and expiry times;
- unused or consumed state.

The raw codes are returned once to the authenticated dashboard as a bootstrap bundle. Each code expires after 60 seconds and is consumed atomically exactly once for its bound route and endpoint.

The dashboard sends each code in the body of an HTTPS `POST` request to the reserved `/__llp/bootstrap` path on its bound endpoint host. For example:

```text
https://ed-{routeId}.workspaces.example.com/__llp/bootstrap
https://pv-{routeId}.workspaces.example.com/__llp/bootstrap
https://tl-{routeId}.workspaces.example.com/__llp/bootstrap
```

The gateway handles reserved `/__llp/` paths and never proxies them to learner tasks. Do not place a code in a query string, fragment, path, referrer, or browser storage. Bootstrap endpoints accept only the configured dashboard origin, require a matching CSRF defense, limit request size, rate-limit failures, and return `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.

After consuming each code, the gateway generates a separate random access verifier. Convex stores only its hash in the access-grant record. The raw verifier is placed in that endpoint host's browser cookie and is never returned in a response body.

## Access Cookie

Use the same host-only cookie name on each endpoint. Browser cookie isolation by hostname allows multiple endpoints and sessions to coexist:

```text
__Host-llp
```

Set these attributes:

```text
Secure; HttpOnly; SameSite=Lax; Path=/
```

Do not set a persistent `Expires` or `Max-Age` attribute. The server-side grant carries the authoritative absolute expiry, which cannot exceed the session expiry. Closing the browser removes the cookie, while logout, stop, expiry, or revocation invalidates the server-side grant.

The `__Host-` prefix, absence of a `Domain` attribute, and `Path=/` bind the cookie to the exact editor, preview, or tools host. Opening another endpoint or session does not replace it.

The hosted dashboard and workspace domain must share the same HTTPS site, such as `app.example.com` and `*.workspaces.example.com`. This lets `SameSite=Lax` cookies support embedded workspaces without depending on third-party cookies. A deployment using unrelated sites requires a separate reviewed design and cannot silently change to `SameSite=None`.

Learner-controlled backends must never receive the access cookie.

## Access Grant Record

An active grant contains:

- grant ID and hashed verifier;
- route ID and session ID;
- owner subject or support subject;
- one endpoint scope: `editor`, `preview`, or `tools`;
- role: `owner` or `support`;
- issued, last-used, and absolute-expiry times;
- status: `active`, `revoked`, or `expired`;
- revocation time and reason when applicable.

Grant IDs and verifiers are independent random values. A database read does not reveal a usable cookie because only verifier hashes are stored.

The bootstrap bundle creates an independent verifier and grant for each authorized endpoint. Owner grants may last until the earlier of session expiry or one hour. Support grants may last at most 15 minutes. The gateway can update `lastUsedAt` asynchronously, but activity never extends absolute expiry.

## Gateway Enforcement

For every HTTP request and WebSocket handshake, the gateway must:

1. Parse and validate the workspace host and endpoint prefix.
2. Load the active route and reject non-active or logically expired routes.
3. Select the host-only `__Host-llp` cookie.
4. Parse the grant ID and verifier with strict length and encoding limits.
5. Hash the verifier and compare it in constant time with the stored hash.
6. Verify grant status, route ID, session ID, endpoint scope, role, and absolute expiry.
7. Apply endpoint-specific origin, method, body-size, and rate-limit policy.
8. Proxy only to the trusted backend coordinates from the active route record.

Return `401` when credentials are absent or invalid and `403` when a valid identity lacks the required route or endpoint scope. Do not reveal whether another learner's session exists.

Gateway instances may cache a successful grant check for no more than five seconds and never beyond route or grant expiry. Revocation events must invalidate matching cache entries and close matching WebSocket connections across gateway replicas within the same five-second bound.

WebSocket authorization occurs during the HTTP upgrade. The gateway validates the `Origin` header against an exact endpoint-specific allowlist and closes the connection when the route or grant expires or is revoked.

## Isolation From Learner Processes

Before proxying to editor, preview, or tools, the gateway removes:

- the platform `__Host-llp` cookie and any `Authorization` request header;
- bootstrap, grant, identity, role, and CSRF headers;
- client-supplied forwarding and internal routing headers.

The gateway rejects ambiguous duplicate platform cookies, removes every platform-cookie occurrence, and may forward remaining application cookies. It adds only sanitized forwarding metadata required by the platform. Learner processes receive no reusable platform credential.

On responses from learner processes, the gateway removes any `Set-Cookie` header that uses a `Domain` attribute, a platform-reserved cookie name, or invalid cookie syntax. Valid host-only application cookies may pass through. The gateway also removes platform-reserved identity and routing headers. Learner-controlled code cannot set or overwrite platform cookies or parent-domain cookies.

The gateway applies platform security headers after removing conflicting reserved headers. Responses containing bootstrap or access state use `Cache-Control: no-store`. Normal editor, preview, and tools caching remains disabled as required by ADR 0003.

## Origin And Request Controls

- Bootstrap, refresh, logout, and other platform-owned state changes require an exact trusted dashboard origin and CSRF protection.
- Editor WebSockets accept only the matching editor origin and explicitly required platform origins.
- Preview hot-module-reload WebSockets accept only the matching preview origin.
- Tools state-changing requests accept only the trusted dashboard and matching tools origins, use an explicit method allowlist, and require CSRF protection.
- CORS uses exact origins. Wildcard origins are not allowed with credentials.
- Unknown methods, oversized bodies, malformed upgrade requests, and invalid hosts are rejected before route lookup where possible.

Learner preview content remains untrusted even though it shares the parent site. It receives no platform cookie or identity header at the task, and it cannot use its origin to access another route or a platform-owned state-changing endpoint.

## Revocation And Lifecycle

Revoke all session grants when:

- the learner or operator stops the session;
- the session expires or errors;
- route state becomes `draining`, `expired`, or `errored`;
- session ownership changes;
- the user logs out or an administrator revokes access;
- suspicious reuse, brute force, or policy violation is detected.

Revocation changes the server-side grant state first, invalidates gateway caches and connections, then continues route and task cleanup. Clearing the browser cookie is helpful but is not the security boundary.

Expired bootstrap codes and grants are filtered by logical expiry on every read. Background deletion is cleanup only and cannot be relied on for timely revocation. Retain non-secret audit metadata according to the product audit policy, then delete verifier hashes and expired bootstrap records.

## Logging And Monitoring

Record:

- bootstrap issuance, consumption, expiry, and replay attempts;
- grant issuance, use, expiry, and revocation;
- support access issuer, subject, reason, and duration;
- authorization failures by reason category without credential values;
- origin and CSRF rejections;
- WebSocket establishment, revocation closure, and abnormal termination;
- rate-limit and brute-force signals.

Never log raw bootstrap codes, access verifiers, cookies, authorization headers, signed URLs, full query strings, or learner file contents. Use request, grant, route, and session identifiers suitable for correlation without exposing identity claims unnecessarily.

## Required Security Tests

Before hosted launch, automated end-to-end tests must prove:

- an unauthenticated browser cannot open any endpoint;
- an owner can bootstrap and open all three granted endpoints;
- another authenticated learner receives no session disclosure or access;
- a support grant is scoped, audited, and expires on time;
- bootstrap codes are single-use, short-lived, and rejected after replay;
- malformed, altered, expired, revoked, and wrong-route cookies fail;
- stop and expiry revoke HTTP and existing WebSocket access within five seconds;
- wrong-origin WebSocket and state-changing HTTP requests fail;
- learner preview and editor backends never receive platform cookies or identity headers;
- learner backend `Set-Cookie` responses cannot modify platform cookies;
- credentials do not appear in URLs, logs, browser storage, or Convex events.

## Alternatives Considered

### Route ID As A Bearer Secret

An unguessable URL is useful defense-in-depth but is not sufficient authorization. URLs leak through browser history, screenshots, referrers, logs, and support workflows. Route IDs remain non-secret identifiers.

### Signed Tokens In Query Strings

Query credentials work for navigation and WebSockets but appear in load balancer logs, browser history, copied URLs, and referrers. They are prohibited.

### Bearer Tokens In Browser Storage

Tokens in `localStorage` or `sessionStorage` are readable by JavaScript and are exposed to cross-site scripting. Workspace grants use `HttpOnly` cookies.

### Parent-Domain Cookie

A parent-domain cookie could bootstrap all three hosts at once, but it would be sent to every workspace hostname and would weaken containment of learner-controlled preview origins. Endpoint host cookies provide a stronger browser boundary and allow safe handling of host-only application cookies.

### Authentication Inside Each Learner Task

Adding authentication independently to OpenVSCode, Vite, and tools would duplicate policy, expose credentials to learner-controlled processes, and complicate task recovery. The gateway enforces access before traffic reaches the task.

### Application Load Balancer OIDC Authentication Alone

Load balancer authentication can verify an identity provider session, but it does not by itself enforce Convex session ownership, endpoint scopes, support grants, or prompt per-session revocation. It may be used as an additional identity layer, not as the complete authorization boundary.

## Consequences

- Hosted launch requires a real identity provider and immutable owner subject, not only readiness environment flags.
- The gateway and Convex schema need bootstrap and access-grant lifecycle operations.
- The dashboard needs a POST-based workspace bootstrap flow before loading workspace iframes.
- Gateway replicas need bounded cache invalidation and WebSocket connection revocation.
- Preview code remains isolated from reusable platform credentials even though it is learner-controlled.
- Infrastructure must protect gateway-to-Convex trust and expose only the bootstrap and proxied workspace surfaces.

## References

- [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- [OWASP WebSocket Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html)
- [OWASP Cross-Site Request Forgery Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)
- [Application Load Balancer listener authentication](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/listener-authenticate-users.html)
