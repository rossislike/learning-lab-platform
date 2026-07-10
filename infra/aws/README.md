# AWS Infrastructure Plan

Use AWS only for disposable execution in the first release. Keep product state in Convex.

The hosted execution model is accepted in [ADR 0001](../../docs/decisions/0001-hosted-execution-model.md): one Amazon ECS standalone task on AWS Fargate per learner session. EKS, EC2-backed workers, and virtual machine orchestration remain escalation paths for requirements the React runner does not have.

## Recommended Initial Services

- ECS Fargate for one task per lab session.
- ECR for runner and optional lab images.
- Application Load Balancer or a lightweight gateway service for editor/preview routing.
- CloudWatch Logs for runner logs.
- IAM task role scoped to session needs only.

## Later Services

- EKS for Kubernetes-specific labs.
- ECR image build/push workflow for deployable app labs.
- S3 for larger lab assets.
- EventBridge Scheduler or Convex cron plus AWS cleanup for TTL enforcement.

## Avoid Initially

- KubeVirt and nested virtualization.
- Per-learner Kubernetes clusters.
- Docker-in-Docker inside learner containers.
- Multi-node labs before the React/Vitest loop works.
