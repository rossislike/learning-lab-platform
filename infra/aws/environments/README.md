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

The guarded wrappers validate the canonical account-security, staging, and
production S3 backend identities and require the `default` workspace for each
root. They hold one conditional S3 operation lock across each supported
operation. Hosted plan records alarm enablement as durable infrastructure
intent. Hosted apply reconciles all 12 shared project alarms before applying
the selected environment. Do not use raw environment Terraform commands because
they do not participate in the cross-root operation lock.

Run `npm install` before using these wrappers. Their synchronous lock helper
uses `@aws-sdk/client-s3`; the current operational AWS CLI service model does
not provide the conditional S3 put and delete inputs required for this lock.

If a hosted apply fails after alarm reconciliation, the lifecycle setting and
alarms remain enabled because the environment may be partially deployed. Use
the guarded teardown and final cleanup after both environment states are empty
to disable them again.

Initialize the account-security, staging, and production roots with their own
canonical backend files before running either hosted environment wrapper. The
cross-root checks intentionally fail if even an inactive root is uninitialized,
points at another state key, or has a non-default workspace.

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
same profile environment to Terraform. Each environment has a Terraform
precondition on the tracked shared-alarm lifecycle setting, and direct alarm
deletion remains blocked by `prevent_destroy`. These fail closed when a wrapper
is bypassed, but they do not make independent raw Terraform processes atomic.
The registry is a repository guard and inventory, not proof that external Clerk
or Convex configuration is correct.
