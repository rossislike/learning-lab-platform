# AWS network boundary deployment evidence

The hosted-runner network boundaries were deployed to staging and production
in AWS account `442359104502`, region `us-east-2`, on 2026-07-12. Staging was
qualified before the same immutable proxy image was promoted to production.

## Boundary matrix

| Source | Allowed destination | Port |
| --- | --- | --- |
| Internet | ALB security group | 443 |
| ALB | Gateway security group | 8080 |
| Gateway | Session security group | 3000, 5173, 8080 |
| Gateway, dispatcher, session | AWS interface endpoints | 443 |
| Gateway, dispatcher, session | Policy-restricted S3 gateway endpoint | 443 |
| Gateway, dispatcher, session | Internal proxy load balancer | 3128 |
| Proxy load balancer | Proxy tasks | 3128 |
| Proxy tasks | Reviewed external HTTPS domains | 443 |

The dispatcher has no ingress rules. The session group has no self-referencing
rule, so one session cannot initiate traffic to another session. Its only
ingress sources are the gateway group on the three session ports. Its only
egress paths are the AWS endpoint group, the policy-restricted S3 managed prefix
list, and the proxy load balancer group. The S3 endpoint policy permits only the
regional ECR starport layer bucket and the environment's owned artifact and
checkpoint buckets, blocking arbitrary third-party S3 buckets. Learner data
access still requires exact-key, short-lived presigned URLs issued by a trusted
gateway or dispatcher because the session task role has no ambient S3 data
permissions. The proxy task group is the only workload group with direct
internet egress, restricted to TCP 443.

## Controlled egress

Each environment runs two ARM64 Squid tasks behind an internal Network Load
Balancer. The image is pinned to digest
`sha256:6ff10a7317f72fb6d891ecfceb6e4c85730b7e77d950ef78a69e0046956a9ba3`.
Squid accepts CONNECT requests only on port 443 and checks the CONNECT
destination against the reviewed domain list in
`infra/aws/egress-proxy/allowed-domains.txt`. Requests do not carry learner
forwarding headers and proxy access logs are written to CloudWatch.

Interface endpoints cover ECR API and Docker, ECS, ECS agent, ECS telemetry,
KMS, CloudWatch Logs, Secrets Manager, and STS. S3 uses a gateway endpoint.
Runner task definitions set uppercase and lowercase HTTP proxy variables to the
private load balancer and bypass AWS endpoints through the corresponding
no-proxy variables. The proxy service depends on its listener, distributes
traffic across both Availability Zones, runs as the non-root `squid` user,
drops all Linux capabilities, and enables the container init process. Its root
filesystem remains writable because Fargate anonymous volumes are root-owned
and prevented the non-root process from creating `/tmp/squid.pid` during
staging qualification.

## Staging qualification

Fargate task `87648c979d8f4564a4e1a8b1efb47fe7` ran in a private subnet with no
public IP and the restricted session security group. It installed the React
scenario dependencies through the proxy, observed the expected starter
failure, applied the solution, and passed the final check. Both the runner and
GuardDuty sidecar exited with code `0`.

Negative-test task `b0fa5bdd1a264a30bb8aa8fe409f5b4e` attempted an npm lookup
through the unreviewed destination `example.com`. Squid denied the CONNECT, so
the lookup failed as required and the negative-test assertion exited with code
`0`.

Final Terraform plans for both staging and production reported no changes.
Production proxy capacity is deployed but production learner traffic remains
blocked by the hosted environment-isolation release gate.
