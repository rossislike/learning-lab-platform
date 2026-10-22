# AWS infrastructure

Terraform for the `dev` environment (ADR 0007) in account `442359104502`,
region `us-east-2`. The Kubernetes execution model is ADR 0005.

| Root / module | Status | Purpose |
|---|---|---|
| [`bootstrap/terraform-backend`](bootstrap/terraform-backend/README.md) | deployed | Private, versioned, KMS-encrypted state bucket with native S3 locking. State keys are listed in [`config/aws-terraform-backends.json`](../../config/aws-terraform-backends.json). |
| [`account-security`](account-security/README.md) | deployed | CloudTrail, GuardDuty, account-level metric filters. Project alarms are off (`enable_learning_lab_alarms=false`) until dev is up. |
| `modules/github-image-delivery` | written, not applied | GitHub OIDC provider + least-privilege roles for CI pushes to ECR. Reused in Phase 6. |
| `modules/eks-platform` | Phase 5 | VPC, EKS Auto Mode cluster, ECR repositories, ACM wildcard + Route 53, scenario-bundle bucket, IRSA for the dispatcher, CloudWatch logs, S3 + CloudFront frontend. |
| `environments/dev` | Phase 5 | The single hosted root. State key `learning-lab-platform/dev/terraform.tfstate`. Deletion protection off. |

Kubernetes manifests are not Terraform: the dispatcher, gateway, namespaces,
RBAC, quotas, and network policies ship as a Helm chart in
`deploy/helm/learning-lab` (Phase 3) and are applied to kind and EKS alike.

Note: `modules/github-image-delivery` and the bootstrap `environment` variable
still carry `staging`/`production` enums; they are updated in Phase 5/6.

```bash
npm run infra:fmt
npm run infra:validate
```

The staging and production roots, the ECS/Fargate module, the egress proxy,
and the disposable validation root were removed on 2026-10-22 (git history up to
and including commit `11916e0` has them).
