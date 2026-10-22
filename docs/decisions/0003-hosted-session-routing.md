# ADR 0003: Hosted Session URL Routing

- Status: Accepted; amended by [ADR 0005](0005-kubernetes-execution-model.md) on 2026-10-22 (ECS task → Kubernetes pod; task ARN/DescribeTasks → pod name/IP)
- Date: 2026-07-09
- Decision owners: Learning Lab Platform maintainers

## Context

Each hosted learner session runs as a standalone Fargate task in a private subnet. The task exposes three HTTP applications:

- OpenVSCode editor with HTTP and WebSocket traffic;
- Vite preview with HTTP and hot-module-reload WebSocket traffic;
- tools and validation endpoint with HTTP traffic.

The task has a private IP address that can change after recovery. Learner URLs must remain stable for the session, support browser embedding and WebSockets, avoid public task IP addresses, and scale beyond Application Load Balancer listener-rule and target-group quotas.

## Decision

Route hosted session traffic through one internet-facing Application Load Balancer and a horizontally scalable session gateway service.

```text
Browser
  -> wildcard Route 53 record
  -> HTTPS Application Load Balancer
  -> session gateway ECS service
  -> private Fargate session task
       -> editor port 3000
       -> preview port 5173
       -> tools port 8080
```

The Application Load Balancer terminates TLS and forwards all workspace hosts to one gateway target group. It does not create listener rules or target groups per learner session. The gateway parses the host, validates access, looks up the active route, and proxies HTTP or WebSocket traffic to the selected private task IP and port.

The secure access mechanism is intentionally defined by the next roadmap decision. The gateway is the enforcement point for that mechanism.

## Public URL Format

Use one opaque, random route ID per session. The route ID is stable across task recovery and must contain at least 128 bits of entropy encoded with DNS-safe lowercase characters.

For a configurable workspace domain such as `workspaces.example.com`, publish:

```text
https://ed-{routeId}.workspaces.example.com/
https://pv-{routeId}.workspaces.example.com/
https://tl-{routeId}.workspaces.example.com/
```

The prefixes identify editor, preview, and tools traffic. All endpoint names are one label beneath the workspace domain so one Route 53 wildcard record and one ACM wildcard certificate for `*.workspaces.example.com` cover them.

Do not put the Convex session ID, learner identity, lab slug, or authorization material in the hostname. The route ID is an identifier, not an authorization credential.

Use separate origins instead of path prefixes. This avoids base-path rewriting for OpenVSCode and Vite, keeps root-relative application paths working, and gives later access controls an endpoint-specific origin boundary.

## DNS And TLS

Create a Route 53 wildcard alias record for `*.workspaces.example.com` that points to the public Application Load Balancer. Redirect port 80 to HTTPS or return a fixed rejection response. Serve workspace traffic only over HTTPS using an ACM certificate validated through DNS.

The actual parent domain is an infrastructure input. Local development continues to use its existing loopback URLs and does not depend on hosted DNS.

## Session Gateway

Run the gateway as a normal multi-task ECS service across at least two Availability Zones. Register the gateway service with one Application Load Balancer target group. The gateway has no learner workspace filesystem and can be deployed independently of learner tasks.

The gateway must:

- accept only recognized workspace host formats;
- map `ed`, `pv`, and `tl` prefixes to fixed internal ports;
- preserve request paths and query strings without application path rewriting;
- proxy HTTP connection upgrades and full-duplex WebSocket traffic;
- forward the original host and standardized forwarding headers;
- generate or propagate a request ID;
- enforce request, header, body, connection, and upstream timeouts appropriate to each endpoint;
- disable response caching for editor, preview, and tools traffic;
- return `404` for unknown route IDs, `410` for expired routes, and `503` for routes that are starting or temporarily unhealthy;
- avoid logging authorization material, cookies, full query strings, or learner file contents.

Configure the Application Load Balancer idle timeout to 3600 seconds for editor and Vite WebSocket connections. Configure gateway upstream timeouts and WebSocket keepalive behavior so the gateway does not close healthy connections before the load balancer.

The gateway must restrict upstream IP addresses to the configured session-task subnet ranges. It must never proxy to loopback, link-local, public, metadata-service, or arbitrary client-supplied addresses.

## Route Registry

Keep the authoritative route record in Convex with the rest of the session control plane. Do not introduce a second routing database for the first hosted release.

A route record contains:

- opaque route ID;
- session ID;
- ECS task ARN;
- private task IP;
- editor, preview, and tools ports;
- route generation;
- state: `starting`, `active`, `draining`, `expired`, or `errored`;
- creation, update, and expiry timestamps.

Only trusted runner and gateway identities can read private backend coordinates. Browser-facing Convex queries must never return task IP addresses or task ARNs.

Gateway instances use a bounded in-memory cache for route lookups. Cached records retain their absolute expiry time, and expired records are rejected without waiting for cache refresh. Cache duration must be short enough for stop and revocation behavior and will be finalized with the secure-access design.

Convex remains authoritative when cache and registry disagree. A temporary Convex outage may allow already cached active routes to continue until their cache deadline, but no new or expired route is activated from stale data.

## Route Registration

Use this startup sequence:

1. Create the session route ID and a `starting` route record.
2. Start the Fargate task with fixed internal ports.
3. Discover the task's private IP from trusted ECS task metadata or `DescribeTasks`.
4. Start editor, preview, and tools processes bound to `0.0.0.0` on their fixed ports.
5. Probe all three endpoints from inside the VPC.
6. Atomically update the route backend, increment its generation, and set it to `active`.
7. Publish the three public URLs and mark the session running in Convex.

URLs are not published as ready until all required endpoints pass readiness checks. Route activation is idempotent for the same session, task ARN, and generation.

When recovering onto a replacement task, keep the same route ID and public URLs. Update the private IP and task ARN with a higher route generation only after the replacement endpoints are ready. The gateway must never combine fields from different generations.

## Stop And Cleanup

Use this shutdown sequence:

1. Change the route state to `draining` so the gateway rejects new connections.
2. Allow a short, configurable drain period for in-flight requests and checkpoint upload.
3. Stop the Fargate task.
4. Change the route state to `expired` and remove private backend coordinates.
5. Clear gateway cache entries through normal short expiry or explicit invalidation.

The route expiry time cannot exceed the session expiry time. Gateway request handling checks logical expiry directly because background database TTL deletion is not an immediate revocation mechanism.

Cleanup is idempotent. An already missing task or route succeeds. Route records may remain as non-routable audit metadata, but private backend coordinates must be removed after cleanup.

## Network Boundaries

- The public Application Load Balancer accepts HTTPS from the internet.
- The gateway service runs in private subnets and accepts traffic only from the load balancer security group.
- Session tasks run without public IP addresses and accept editor, preview, and tools traffic only from the gateway security group.
- Session tasks use controlled outbound access for Convex, S3 artifact and checkpoint operations, ECR, and required package installation.
- Direct browser-to-task traffic is not allowed.

## Health And Observability

Record these signals without logging sensitive request data:

- route activation and drain duration;
- gateway lookup and proxy latency by endpoint type;
- active HTTP and WebSocket connections;
- cache hit and miss counts;
- backend connection failures and readiness failures;
- responses by status class and route state;
- stale-generation update attempts;
- route cleanup failures.

Use Application Load Balancer access logs and gateway structured logs with request IDs. Do not treat a gateway health check as proof that a learner task is healthy. Session endpoint health remains a separate signal.

Because load balancer access logs include request URLs, the secure-access design must not place credentials or bearer tokens in query parameters.

## Alternatives Considered

### Per-Session Application Load Balancer Rules And Target Groups

Application Load Balancers can route by host and register private IP targets, but a target group routes among all of its registered targets. Preserving a host-to-session mapping would require dynamic per-session rules and target groups. The default quotas of 100 rules and 100 target groups per load balancer make this unsuitable as the primary multi-session design.

### Path-Based Routing

A single hostname with `/sessions/{id}/editor`, `/preview`, and `/tools` paths reduces DNS names but requires path rewriting and application-specific base-path configuration. It also complicates WebSocket URLs, root-relative assets, cookies, and isolation between learner-authored preview code and platform endpoints.

### Public IP Per Session Task

Direct public task access would expose ephemeral infrastructure addresses, complicate certificates and DNS, and broaden the task security-group boundary. Session tasks remain private.

### API Gateway Or CloudFront In Front Of Every Session

These services may become useful for global delivery or additional edge controls, but they do not remove the need for dynamic session-to-private-task routing. Adding them now would create another proxy layer without satisfying a current requirement.

### Separate DynamoDB Route Registry

DynamoDB could provide a low-latency ephemeral route table, but Convex already owns session lifecycle and expiry. A second authoritative store would add synchronization and cleanup failure modes. Reconsider a dedicated route registry only if measured gateway lookup load or availability requirements exceed the Convex-backed design.

## Consequences

- A shared session gateway becomes a critical data-plane service and must be highly available, bounded, observable, and independently deployable.
- Hosted URLs remain stable when a task is replaced.
- Infrastructure code needs Route 53, ACM, an Application Load Balancer, gateway service capacity, security groups, access logging, and health checks.
- The runner and Convex schema need route identifiers, generations, states, backend coordinates, and expiry metadata.
- Secure session authorization can be added once at the gateway instead of separately inside OpenVSCode, Vite, and tools.

## References

- [Application Load Balancer listener rules](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/listener-rules.html)
- [Application Load Balancer quotas](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-limits.html)
- [Application Load Balancer target groups](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-target-groups.html)
- [Application Load Balancer attributes and idle timeout](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-load-balancer-attributes.html)
- [Elastic Load Balancing WebSocket support](https://docs.aws.amazon.com/elasticloadbalancing/latest/userguide/how-elastic-load-balancing-works.html)
- [Amazon ECS task networking with `awsvpc`](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-networking-awsvpc.html)
- [Route 53 wildcard record behavior](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/DomainNameFormat.html)
