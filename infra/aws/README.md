# AWS infrastructure

Terraform for the `dev` environment (ADR 0007) in account `442359104502`,
region `us-east-2`. The Kubernetes execution model is ADR 0005.

| Root / module | Status | Purpose |
|---|---|---|
| [`bootstrap/terraform-backend`](bootstrap/terraform-backend/README.md) | deployed | Private, versioned, KMS-encrypted state bucket with native S3 locking. State keys are listed in [`config/aws-terraform-backends.json`](../../config/aws-terraform-backends.json). |
| [`account-security`](account-security/README.md) | deployed | CloudTrail, GuardDuty, account-level metric filters. Project alarms are off (`enable_learning_lab_alarms=false`) until dev is up. |
| `modules/github-image-delivery` | written, not applied | GitHub OIDC provider + least-privilege roles for CI pushes to ECR. Reused in Phase 6. |
| `modules/eks-platform` | written (Phase 5) | VPC (2 AZ, NAT per AZ, S3 gateway endpoint), EKS Auto Mode cluster (Kubernetes 1.34, standard support only, `general-purpose` + `system` pools, control-plane logs; outputs the service CIDR for the sessions DNS egress rule), ECR repositories, ACM wildcard certificates (`us-east-2` for the ALB, `us-east-1` for CloudFront) validated in Route 53, scenario-bundle bucket, EKS Pod Identity role for the dispatcher (`s3:GetObject` on `scenarios/*/bundles/sha256/*` only), S3 + CloudFront (OAC) frontend with `app.<env>.<domain>` alias records. |
| `environments/dev` | written (Phase 5) | The single hosted root. State key `learning-lab-platform/dev/terraform.tfstate`. Deletion protection off. `npm run infra:dev:init|plan|apply|destroy` (`create_dns_zone` needs a targeted zone apply first; run `npm run deploy:dev -- teardown` before destroy); runbook in [`docs/dev-environment.md`](../../docs/dev-environment.md). Commit its `.terraform.lock.hcl` after the first init. |

Kubernetes manifests are not Terraform: the dispatcher, gateway, namespaces,
RBAC, quotas, and network policies ship as a Helm chart in
`deploy/helm/learning-lab` (Phase 3) and are applied to kind and EKS alike.

Note: `modules/github-image-delivery` and the bootstrap `environment` variable
still carry `staging`/`production` enums; they are updated in Phase 5/6.

```bash
npm run infra:fmt
npm run infra:validate        # each root must be `terraform init`ed first (dev: npm run infra:dev:init)
```

The `*.<env>.<domain>` record that points session hosts at the gateway's ALB
is not Terraform: `npm run deploy:dev -- dns` writes it once the Ingress
exists, and `npm run deploy:dev -- teardown` removes it (with the ALB)
before `infra:dev:destroy`. Everything else the deploy script needs is read from
`terraform output -json` in `environments/dev`.

The staging and production roots, the ECS/Fargate module, the egress proxy,
and the disposable validation root were removed on 2026-10-22 (git history up to
and including commit `11916e0` has them).
