# AWS Infrastructure Plan

Use AWS only for disposable execution in the first release. Keep product state in Convex.

Use `us-east-2` as the default AWS region. Deployments can override it with `AWS_REGION` when regional requirements change.

The hosted execution model is accepted in [ADR 0001](../../docs/decisions/0001-hosted-execution-model.md): one Amazon ECS standalone task on AWS Fargate per learner session. EKS, EC2-backed workers, and virtual machine orchestration remain escalation paths for requirements the React runner does not have.

The workspace storage model is accepted in [ADR 0002](../../docs/decisions/0002-hosted-workspace-storage.md): use Fargate ephemeral storage for the live workspace and private S3 buckets for immutable scenario artifacts and short-lived recovery checkpoints.

The hosted routing model is accepted in [ADR 0003](../../docs/decisions/0003-hosted-session-routing.md): terminate wildcard workspace HTTPS at one public Application Load Balancer and proxy through a session-aware gateway service to private Fargate tasks. Keep route records authoritative in Convex.

The hosted access model is accepted in [ADR 0004](../../docs/decisions/0004-secure-session-access.md): authorize authenticated owners or explicit support grants, exchange endpoint-bound one-time codes through HTTPS POST requests, and enforce host-only `HttpOnly` cookies at the gateway without forwarding credentials to learner tasks.

## Recommended Initial Services

- ECS Fargate for one task per lab session.
- ECR for runner and optional lab images.
- S3 for versioned scenario artifacts and session checkpoints.
- Route 53 and ACM for wildcard workspace DNS and TLS.
- One Application Load Balancer and a highly available session gateway service.
- CloudWatch Logs for runner logs.
- IAM task role scoped to session needs only.

## Later Services

- EKS for Kubernetes-specific labs.
- ECR image build/push workflow for deployable app labs.
- EFS or EBS if later labs require persistent shared or block storage.
- EventBridge Scheduler or Convex cron plus AWS cleanup for TTL enforcement.

## Avoid Initially

- KubeVirt and nested virtualization.
- Per-learner Kubernetes clusters.
- Docker-in-Docker inside learner containers.
- Multi-node labs before the React/Vitest loop works.
