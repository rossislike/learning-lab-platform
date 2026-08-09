# Hosted runner Terraform module

This module is the reusable AWS resource contract for validation, staging, and
production hosted-runner environments. It owns the VPC, private Fargate task
boundary, ECS and ECR resources, artifact and checkpoint buckets, logs, and TTL
cleanup safety net.

Each environment receives a rotation-enabled KMS key. ECR and both S3 data
buckets use that key, and S3 Bucket Keys reduce recurring KMS request cost.

The network contract uses separate security groups for the public ALB,
private gateway, private dispatcher, learner sessions, AWS interface endpoints,
and controlled egress proxy. Session ports `3000`, `5173`, and `8080` accept
traffic only from the gateway group. The dispatcher has no ingress rules.
Private workloads can reach AWS APIs through interface endpoints and S3 through
the gateway endpoint. The S3 endpoint policy limits that route to regional ECR
image layers and the environment's owned artifact and checkpoint buckets, so
arbitrary third-party buckets remain blocked. Learner data access still
requires exact-key presigned URLs. Boundary-enabled staging and production
learners have no task IAM role, while disabled roots retain the prior task role
without S3 permissions. External HTTPS uses the internal proxy load balancer on port
`3128`. Only the proxy task security group has direct HTTPS internet egress,
and Squid permits CONNECT requests only to reviewed domains and the four owned
environment bucket hostnames.

Protected environments enable an internet-facing ALB with HTTP redirected to
HTTPS. ACM certificates are created in the workload region and validated with
one shared Route 53 CNAME for the base and wildcard names. Both the environment
hostname and its wildcard workspace hostname
resolve to the ALB. Until the authenticated gateway service is deployed, the
HTTPS listener returns an HTTP 503 `gateway-deployment-pending` JSON status and
does not
route requests to session tasks.

The proxy runs as the image's non-root `squid` user, drops every Linux
capability, and enables the container init process. Its container root remains
writable because Fargate anonymous volumes are root-owned and prevent the
non-root process from writing its PID beneath `/tmp`.

## Compatibility contract and source version

The current compatibility contract is `1.0.0`. Every caller passes
`module_contract_version = "1.0.0"`, and the module rejects any other value.
Changes that rename resources, alter required inputs, or change output types
must increment the contract version and include state migration instructions.
This input is compatibility metadata. It does not identify the module source
and must not be treated as an immutable source pin.

The module is currently consumed from this repository by a relative source
path, so the immutable repository commit is the module source version. CI must
promote one reviewed repository commit and its image digests together.
If the module is later published separately, callers must pin an immutable
registry version or Git commit rather than a branch.

## Persistent environment safeguards

Staging and production callers must enable `deletion_protection` and provide a
runner image pinned with `@sha256:<digest>`. Protected artifact buckets,
checkpoint buckets, and ECR repositories use Terraform `prevent_destroy` and
never force-delete contents. Disposable validation uses separate resource
addresses so its stack can still be destroyed intentionally.

This protection covers the stateful artifact and checkpoint buckets and the
runner ECR repository. It does not prevent destruction of stateless compute,
networking, IAM, logging, or cleanup resources. Backend state protection is
owned separately by the backend bootstrap stack.

Changing `deletion_protection` after an environment is created changes the
resource address and is not supported. Treat it as an immutable environment
property.

Set `enable_learner_metadata_boundary = true` only after qualification in the
target environment. Staging and production are currently enabled. When enabled,
the learner task has no task IAM role, so ECS does not vend task
credentials to learner processes. The execution role remains agent-only for
image pulls and log delivery. The learner container entrypoint removes AWS
credential, ECS agent, and ECS metadata endpoint variables before it starts
the non-root, capability-free workload. Fargate still creates an opaque
per-container metadata URI, but the learner process never receives that URI.
EC2 IMDS and unrelated link-local addresses remain unreachable, and the egress
proxy bypass list excludes every link-local address.

The module retains the empty IAM role resource at its original Terraform state
address in every environment. With the boundary enabled, the task definition
does not reference that role, so ECS does not vend its credentials.

When the setting is false, the module preserves the previous learner task
definition, including its empty task IAM role and link-local proxy bypass
entries. This is the default and is explicitly selected by the disposable
validation root.

With the boundary enabled, the task definition supplies a command explicitly
because an ECS entrypoint override does not inherit the image's default
command. Set `runner_image_kind = "validation"` for the scenario validation
image or `runner_image_kind = "learner-session"` for the interactive image.
The learner-session contract also adds fixed editor, preview, and tools port
mappings plus the ECS container health check. `runner_command` remains an
optional escape hatch for a reviewed image-specific override.

Future artifact and checkpoint access must remain exact-key, short-lived, and
issued by a trusted control-plane component.

## Service credential boundary

Set `enable_service_secret_boundary = true` for persistent environments after
qualification. The module then creates protected metadata for the dispatcher
runner shared secret, an independent KMS key, a startup execution role scoped
to that exact secret, and a separate runtime role scoped to learner task
lifecycle operations in the environment cluster. Terraform intentionally does
not create a secret version, so plaintext never enters Terraform state.

Staging and production enable this boundary. Disposable validation leaves it
disabled. The learner task definition and its image-and-logs execution role do
not receive Secrets Manager or KMS decryption access. Follow the
[service credential runbook](../../../../docs/aws-service-credential-boundary.md)
to seed and validate secret versions without exposing their values.
