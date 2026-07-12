# AWS environment roots

The hosted-runner module has three callers:

| Root | Purpose | State | Destructive settings |
| --- | --- | --- | --- |
| `terraform/` | Disposable validation and Fargate scenario proof | Local by default | Allowed explicitly |
| `environments/staging/` | Production-equivalent qualification | Separate staging backend and account | Protected |
| `environments/production/` | Learner production workloads | Production S3 backend | Protected |

Staging and production require different AWS account IDs, backend buckets,
state keys, VPC CIDRs, and immutable image digests. Never initialize staging
with the production backend file or credentials.

## Staging

```sh
cp infra/aws/environments/staging/staging.tfvars.example \
  infra/aws/environments/staging/staging.tfvars
cp infra/aws/environments/staging/staging.s3.tfbackend.example \
  infra/aws/environments/staging/staging.s3.tfbackend

terraform -chdir=infra/aws/environments/staging init \
  -reconfigure \
  -backend-config=staging.s3.tfbackend
terraform -chdir=infra/aws/environments/staging plan \
  -var-file=staging.tfvars
```

## Production

```sh
cp infra/aws/environments/production/production.tfvars.example \
  infra/aws/environments/production/production.tfvars
cp infra/aws/environments/production/production.s3.tfbackend.example \
  infra/aws/environments/production/production.s3.tfbackend

terraform -chdir=infra/aws/environments/production init \
  -reconfigure \
  -backend-config=production.s3.tfbackend
terraform -chdir=infra/aws/environments/production plan \
  -var-file=production.tfvars
```

The production backend is already provisioned. Its hosted-runner key remains
empty until the first state-writing production operation. Staging must not be
created in the production account; bootstrap its backend only after the
separate staging account is available.

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
