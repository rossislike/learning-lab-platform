# Hosted runner Terraform module

This module is the reusable AWS resource contract for validation, staging, and
production hosted-runner environments. It owns the VPC, private Fargate task
boundary, ECS and ECR resources, artifact and checkpoint buckets, logs, and TTL
cleanup safety net.

Each environment receives a rotation-enabled KMS key. ECR and both S3 data
buckets use that key, and S3 Bucket Keys reduce recurring KMS request cost.

The network contract uses separate security groups for the future public ALB,
private gateway, private dispatcher, learner sessions, AWS interface endpoints,
and controlled egress proxy. Session ports `3000`, `5173`, and `8080` accept
traffic only from the gateway group. The dispatcher has no ingress rules.
Private workloads can reach AWS APIs through interface endpoints and S3 through
the gateway endpoint. The S3 endpoint policy limits that route to regional ECR
image layers and the environment's owned artifact and checkpoint buckets, so
arbitrary third-party buckets remain blocked. Learner data access still
requires exact-key presigned URLs because the task role has no ambient S3 data
permissions. External HTTPS uses the internal proxy load balancer on port
`3128`. Only the proxy task security group has direct HTTPS internet egress,
and Squid permits CONNECT requests only to reviewed domains and the four owned
environment bucket hostnames.

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

The task role intentionally has no ambient S3 data permissions. Future
artifact and checkpoint access must remain exact-key, short-lived, and issued
by a trusted control-plane component.
