# AWS infrastructure

Terraform for the `dev` environment (ADR 0007) in account `442359104502`,
region `us-east-2`. The Kubernetes execution model is ADR 0005.

**None of these roots is deployed right now.** `environments/dev` was
destroyed on 2026-10-30, `account-security` and `bootstrap/terraform-backend`
on 2026-11-23. [Full teardown](#full-teardown) lists the little that is left
in the account, and [Bringing it back](#bringing-it-back) is the way back.

| Root / module | Status | Purpose |
|---|---|---|
| [`bootstrap/terraform-backend`](bootstrap/terraform-backend/README.md) | destroyed 2026-11-23 | Private, versioned, KMS-encrypted state bucket with native S3 locking. State keys are listed in [`config/aws-terraform-backends.json`](../../config/aws-terraform-backends.json). |
| [`account-security`](account-security/README.md) | destroyed 2026-11-23 | CloudTrail, GuardDuty, account-level metric filters and the matching CloudWatch alarms (`enable_learning_lab_alarms=true` since Phase 6). |
| `modules/github-deploy` | written (Phase 6) | GitHub Actions deploy role for dev: ECR push, read-only Terraform state, bundle/frontend buckets, CloudFront invalidation, the `*.dev` Route 53 record, `eks:DescribeCluster` (+ a cluster-admin access entry from the dev root). Trusts only the `dev` GitHub environment (OIDC subject `…:environment:dev`; its deployment-branch rule must allow `main` only) via the account-level OIDC provider. |
| `modules/eks-platform` | written (Phase 5) | VPC (2 AZ, NAT per AZ, S3 gateway endpoint), EKS Auto Mode cluster (Kubernetes 1.34, standard support only, `general-purpose` + `system` pools, control-plane logs; outputs the service CIDR for the sessions DNS egress rule), ECR repositories, ACM wildcard certificates (`us-east-2` for the ALB, `us-east-1` for CloudFront) validated in Route 53, scenario-bundle bucket, EKS Pod Identity role for the dispatcher (`s3:GetObject` on `scenarios/*/bundles/sha256/*` only), S3 + CloudFront (OAC) frontend with `app.<env>.<domain>` alias records. |
| `environments/dev` | destroyed 2026-10-30 | The single hosted root. State key `learning-lab-platform/dev/terraform.tfstate`. Deletion protection off. `npm run infra:dev:init|plan|apply|destroy` (`create_dns_zone` needs a targeted zone apply first; run `npm run deploy:dev -- teardown` before destroy); runbook in [`docs/dev-environment.md`](../../docs/dev-environment.md). Commit its `.terraform.lock.hcl` after the first init. |

Kubernetes manifests are not Terraform: the dispatcher, gateway, namespaces,
RBAC, quotas, and network policies ship as a Helm chart in
`deploy/helm/learning-lab` (Phase 3) and are applied to kind and EKS alike.

Note: the bootstrap `environment` variable still carries the old
`staging`/`production` enum; it is only used for the state bucket name.

```bash
npm run infra:fmt
npm run infra:validate        # each root must be `terraform init`ed first (dev: npm run infra:dev:init)
```

The `*.<env>.<domain>` record that points session hosts at the gateway's ALB
is not Terraform: `npm run deploy:dev -- dns` writes it once the Ingress
exists, and `npm run deploy:dev -- teardown` removes it (with the ALB)
before `infra:dev:destroy`. Everything else the deploy script needs is read from
`terraform output -json` in `environments/dev`.

## Full teardown

Use an administrator identity and destroy in this order; each root's state
lives in the bucket the last step removes.

1. **GitHub**: delete the repository variable `AWS_DEPLOY_ROLE_ARN` first.
   CI skips the deploy job while it is unset, so a push to `main` in the
   middle of the teardown cannot deploy against missing infrastructure.
2. **`environments/dev`**: `npm run deploy:dev -- teardown`, then
   `npm run infra:dev:destroy` ([runbook](../../docs/dev-environment.md)).
3. **`account-security`**: see
   [its README](account-security/README.md#teardown). The alarms, the alert
   topic and the CloudTrail live here, not in `dev`, so they keep running
   (and keep emailing) until this root is destroyed.
4. **`bootstrap/terraform-backend`**: see
   [its README](bootstrap/terraform-backend/README.md#teardown).

Not removed by any of this:

- The account-level GitHub OIDC provider, when roles of other projects trust
  it. On 2026-11-23 it was taken out of the `account-security` state and left
  in AWS for that reason.
- The three KMS keys (CloudTrail, security alerts, Terraform state), until
  their 30-day deletion window ends.
- The pre-existing `rumo-claims-trail`, which this repository never managed.
- GitHub: the secrets `CONVEX_DEPLOY_KEY` and `RUNNER_SHARED_SECRET` and the
  `dev` environment. Delete or rotate the secrets if the project is not
  coming back.
- Everything else outside AWS: the Convex deployment, the Clerk instance and
  its DNS records under the parent domain.

## Bringing it back

A new bootstrap recreates the state bucket under the same name but with a
**new KMS key**, and the old key's ARN is written down in several places.
Until step 2 is done, `config/aws-terraform-backends.json` names a bucket and
a key that no longer exist.

1. Bootstrap the backend
   ([Bootstrap](bootstrap/terraform-backend/README.md#bootstrap)).
2. Copy the new `state_kms_key_arn` output into `kmsKeyId` in
   [`config/aws-terraform-backends.json`](../../config/aws-terraform-backends.json)
   (CI builds its backend config from it) and into the default of
   `terraform_state_kms_key_arn` in `environments/dev/variables.tf` (the
   deploy role's KMS permissions), and commit both.
3. Refill the ignored `account-security/account-security.s3.tfbackend` and
   `environments/dev/dev.s3.tfbackend` from the `runner_backend_config`
   output; the copies left on a machine from before the teardown hold the old
   key. Run `init` with `-reconfigure` in a root that was initialised before.
4. Apply `account-security`, importing the GitHub OIDC provider first if it
   is still in the account ([Usage](account-security/README.md#usage)).
5. Apply and deploy `dev` ([runbook](../../docs/dev-environment.md)).
6. Set the repository variables again
   ([list](../../docs/dev-environment.md#ci-main-deploys-to-dev)), with
   `AWS_DEPLOY_ROLE_ARN` taken from the new `github_deploy_role_arn` output.
   None was set as of 2026-11-23, and CI only deploys once that one is back.

The staging and production roots, the ECS/Fargate module, the egress proxy,
and the disposable validation root were removed on 2026-10-22 (git history up to
and including commit `11916e0` has them).
