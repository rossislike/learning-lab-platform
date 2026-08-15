# AWS environment roots

The hosted-runner module has three callers:

| Root | Purpose | State | Destructive settings |
| --- | --- | --- | --- |
| `terraform/` | Disposable validation and Fargate scenario proof | Local by default | Allowed explicitly |
| `environments/staging/` | Production-equivalent qualification | Staging state key in the shared backend | Protected |
| `environments/production/` | Learner production workloads | Production S3 backend | Protected |

Staging and production use account `442359104502` and one account-level state
bucket. They always require distinct state keys, VPC CIDRs, resource names,
IAM roles, KMS keys, ECR repositories, object storage, secrets, and immutable
image digests. Never initialize one environment with the other environment's
backend file.

The AWS account IDs are part of the broader hosted environment isolation gate.
See [`docs/environment-isolation.md`](../../../docs/environment-isolation.md)
and use the guarded commands below for hosted plan and apply operations.

## Staging

```sh
cp infra/aws/environments/staging/staging.tfvars.example \
  infra/aws/environments/staging/staging.tfvars
cp infra/aws/environments/staging/staging.s3.tfbackend.example \
  infra/aws/environments/staging/staging.s3.tfbackend

AWS_PROFILE=default terraform -chdir=infra/aws/environments/staging init \
  -reconfigure \
  -backend-config=staging.s3.tfbackend
AWS_PROFILE=default npm run infra:staging:plan -- -- -var-file=staging.tfvars
AWS_PROFILE=default npm run infra:staging:apply -- -- -var-file=staging.tfvars
```

## Production

```sh
cp infra/aws/environments/production/production.tfvars.example \
  infra/aws/environments/production/production.tfvars
cp infra/aws/environments/production/production.s3.tfbackend.example \
  infra/aws/environments/production/production.s3.tfbackend

AWS_PROFILE=default terraform -chdir=infra/aws/environments/production init \
  -reconfigure \
  -backend-config=production.s3.tfbackend
AWS_PROFILE=default npm run infra:production:plan -- -- -var-file=production.tfvars
AWS_PROFILE=default npm run infra:production:apply -- -- -var-file=production.tfvars
```

The account-level backend is already provisioned. Each hosted root uses its own
key in that backend. Confirm the backend file and key before every
`init -reconfigure` operation.

## Validation

Run all roots without configuring remote backends when checking source changes:

```sh
terraform -chdir=infra/aws/terraform init -backend=false
terraform -chdir=infra/aws/environments/staging init -backend=false
terraform -chdir=infra/aws/environments/production init -backend=false
npm run infra:validate
```

Use `-reconfigure` whenever changing a root between backendless validation and
its remote backend. Review any backend migration prompt carefully. These roots
must never migrate state between staging and production backends.

The wrappers discard ambient AWS credential overrides, force
`AWS_PROFILE=default`, verify the registry and active AWS account, and pass the
same profile environment to Terraform. Terraform also reads
the registry during plan and apply, which protects against an accidental direct
command while identities are incomplete or the expected account differs. The
registry is a repository guard and inventory, not proof that external Clerk or
Convex configuration is correct.
