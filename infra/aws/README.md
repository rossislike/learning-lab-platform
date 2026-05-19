# AWS Infrastructure Plan

Use AWS only for disposable execution in the first release. Keep product state in Convex.

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
