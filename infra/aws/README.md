# AWS Infrastructure Plan

Use AWS only for disposable execution in the first release. Keep product state in Convex.

Use `us-east-2` as the default AWS region. Deployments can override it with `AWS_REGION` when regional requirements change.

The hosted execution model is accepted in [ADR 0001](../../docs/decisions/0001-hosted-execution-model.md): one Amazon ECS standalone task on AWS Fargate per learner session. EKS, EC2-backed workers, and virtual machine orchestration remain escalation paths for requirements the React runner does not have.

The workspace storage model is accepted in [ADR 0002](../../docs/decisions/0002-hosted-workspace-storage.md): use Fargate ephemeral storage for the live workspace and private S3 buckets for immutable scenario artifacts and short-lived recovery checkpoints.

## Recommended Initial Services

- ECS Fargate for one task per lab session.
- ECR for runner and optional lab images.
- S3 for versioned scenario artifacts and session checkpoints.
- Application Load Balancer or a lightweight gateway service for editor/preview routing.
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
