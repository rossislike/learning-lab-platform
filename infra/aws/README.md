# AWS hosted runner infrastructure

This Terraform stack provisions the first hosted runner environment in `us-east-2`. It keeps session tasks in private subnets and preserves the local runner as a separate development path.

Reusable resources live in
[`modules/hosted-runner`](modules/hosted-runner/README.md). The existing
[`terraform`](terraform) root remains the disposable validation caller.
Separate protected roots for
[`staging`](environments/staging) and
[`production`](environments/production) own account guards, remote state,
CIDRs, retention settings, and immutable image inputs. See the
[environment root guide](environments/README.md).

## Resources

- A dedicated VPC spanning two availability zones
- Public subnets with one NAT gateway per availability zone
- Private subnets and an outbound-only security group for Fargate tasks
- An ECS cluster and an ARM64 Fargate task definition
- An immutable, scan-on-push, KMS-encrypted ECR repository
- Private, KMS-encrypted S3 buckets for scenario artifacts and short-lived checkpoints
- CloudWatch log groups with finite retention
- A scheduled Lambda reaper that stops expired managed ECS tasks every minute
- An optional learner metadata boundary, enabled and validated in staging and
  production, plus scoped agent-only execution and cleanup roles
- A protected dispatcher service secret with separate startup secret access
  and runtime learner-task permissions in staging and production

The default task size is 1 vCPU, 2 GiB of memory, and 21 GiB of ephemeral storage. Override the variables when measurements from a production workload justify different values.

## Prerequisites

- Terraform 1.10 or newer
- Docker with ARM64 build support
- AWS credentials allowed to manage the resources in this stack
- AWS CLI configured for account and region verification

## Build and push the runner image

Create the ECR repository first if it does not exist yet:

```sh
terraform -chdir=infra/aws/terraform init
terraform -chdir=infra/aws/terraform apply \
  -target=module.hosted_runner.aws_ecr_repository.runner_disposable[0] \
  -var=environment=validation \
  -var=runner_image_uri=not-used-during-ecr-bootstrap
```

Authenticate Docker, build the validation image, and push it:

```sh
AWS_ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
ECR_HOST="${AWS_ACCOUNT_ID}.dkr.ecr.us-east-2.amazonaws.com"
IMAGE_TAG="validation-$(date -u +%Y%m%d%H%M%S)"

aws ecr get-login-password --region us-east-2 \
  | docker login --username AWS --password-stdin "${ECR_HOST}"
docker build --platform linux/arm64 \
  -f runner/hosted-validation.Dockerfile \
  -t "${ECR_HOST}/learning-lab-platform-validation-runner:${IMAGE_TAG}" .
docker push "${ECR_HOST}/learning-lab-platform-validation-runner:${IMAGE_TAG}"
```

Use the immutable digest printed by the push for deployment.

The validation Dockerfile pins the multi-platform Node base image index by digest. The pinned index currently includes a `linux/arm64/v8` manifest and is compatible with the default ARM64 task definition. To update it, inspect the current image with `docker buildx imagetools inspect node:20-bookworm-slim`, confirm the ARM64 manifest is present, replace the digest in `runner/hosted-validation.Dockerfile`, rebuild for `linux/arm64`, and rerun the hosted scenario before deployment.

## Deploy

```sh
cp infra/aws/terraform/terraform.tfvars.example infra/aws/terraform/terraform.tfvars
```

Set `runner_image_uri` in `terraform.tfvars` to the ECR URI pinned with `@sha256:...`, then run:

```sh
npm run infra:fmt
npm run infra:validate
terraform -chdir=infra/aws/terraform apply
```

Terraform outputs the cluster, task definition, private subnet IDs, security group, log group, storage buckets, and cleanup function needed by the dispatcher and operations tooling.

`runner_image_uri` is required. Production rejects image references that are not pinned with `@sha256:` and a 64-character lowercase digest. `ecr_force_delete` defaults to `false`; enable it only for a disposable validation environment.

The execution role can pull only the configured runner repository and the AWS-managed `aws-guardduty-agent-fargate` repository in the deployment region. The latter is required when GuardDuty Runtime Monitoring injects its security sidecar into Fargate tasks.

For an environment that already provides private egress through VPC endpoints or another controlled route, set `enable_nat_gateway = false`. Session tasks need outbound access to ECR, CloudWatch Logs, S3, Convex, and any package registries used by a lab.

## TTL contract

Every hosted task launched by the dispatcher carries these tags:

- `learning-lab:managed=true`
- `learning-lab:session-id=<session id>`
- `learning-lab:lab-slug=<lab slug>`
- `learning-lab:expires-at=<ISO 8601 timestamp>`

The application dispatcher still stops sessions during normal lifecycle processing. The scheduled Lambda is an independent safety net for process failure, restarts, or missed application cleanup. It scans only running tasks and accepts only canonical UTC timestamps that round-trip through `Date.toISOString()`. A managed task with a missing, malformed, or excessive expiry tag is reported through logs and the `MalformedManagedTaskTtl` CloudWatch metric. It is stopped after `ttl_max_managed_runtime_seconds`, which defaults to eight hours. If ECS does not provide a usable task creation time, the fail-safe stops the task immediately. Cleanup API failures fail the Lambda invocation and activate the `AWS/Lambda` Errors alarm.

## Session storage access

In staging and production, the Fargate learner task intentionally has no task
IAM role, so ECS does not vend task-role credentials to learner processes. The
disposable validation root retains the prior empty task role until separately
qualified. This enforces the storage decision in ADR 0002: a trusted dispatcher
or signing endpoint must issue short-lived, operation-specific presigned access
for one exact artifact or checkpoint key.
Cleanup deletion remains a trusted control-plane operation. Do not add
bucket-prefix permissions to any learner task role. Both buckets deny requests
that do not use TLS. They reject explicit non-KMS encryption and explicit KMS
keys other than the environment key. Headerless writes use the bucket's
default environment KMS key.

The signing endpoint, safe archive extraction, checkpoint upload and restore, and metadata reporting are future platform work. The completed hosted validation covers the scoped React scenario runner, not a full interactive learner session.

## Production Terraform state

Local Terraform state is allowed only for a disposable validation stack.
Production uses the independent stack in
[`bootstrap/terraform-backend`](bootstrap/terraform-backend/README.md) to
create a versioned, KMS-encrypted, private S3 backend with native S3 lockfiles.
DynamoDB locking is not used.

After applying the bootstrap stack, configure production state:

```sh
cp infra/aws/environments/production/production.s3.tfbackend.example \
  infra/aws/environments/production/production.s3.tfbackend
cp infra/aws/environments/production/production.tfvars.example \
  infra/aws/environments/production/production.tfvars
```

Replace the staging placeholders when its separate account is available.
The production example is prefilled with the existing backend identifiers.
Initialize production with its backend configuration:

```sh
terraform -chdir=infra/aws/environments/production init \
  -reconfigure \
  -backend-config=production.s3.tfbackend
```

The backend bucket and KMS key are deliberately outside this stack so
destroying runner infrastructure cannot destroy its own state or lock. Never
commit generated backend files, which contain environment-specific details.
The production deployment and recovery evidence is recorded in
[`docs/aws-production-backend-validation.md`](../../docs/aws-production-backend-validation.md).
The staging-first hosted environment deployment is recorded in
[`docs/aws-environment-foundation-deployment.md`](../../docs/aws-environment-foundation-deployment.md).

## Destroy a validation stack

```sh
terraform -chdir=infra/aws/terraform destroy \
  -var=environment=validation \
  -var=ecr_force_delete=true \
  -var=runner_image_uri='<the deployed image URI>'
```

Production artifact data is not configured for forced deletion. Empty or retain required data before destroying a production stack.

Staging and production use a guarded multi-phase teardown instead of a direct
`terraform destroy`. Follow the
[hosted environment teardown runbook](../../docs/aws-environment-teardown.md).
