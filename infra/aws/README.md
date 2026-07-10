# AWS hosted runner infrastructure

This Terraform stack provisions the first hosted runner environment in `us-east-2`. It keeps session tasks in private subnets and preserves the local runner as a separate development path.

## Resources

- A dedicated VPC spanning two availability zones
- Public subnets with one NAT gateway per availability zone
- Private subnets and an outbound-only security group for Fargate tasks
- An ECS cluster and an ARM64 Fargate task definition
- An immutable, scan-on-push ECR repository
- Private, encrypted S3 buckets for scenario artifacts and short-lived checkpoints
- CloudWatch log groups with finite retention
- A scheduled Lambda reaper that stops expired managed ECS tasks every minute
- A task role with no ambient S3 data access, plus scoped execution and cleanup roles

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
  -target=aws_ecr_repository.runner \
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

The Fargate task role intentionally has no S3 data permissions. This enforces the storage decision in ADR 0002: a trusted dispatcher or signing endpoint must issue short-lived, operation-specific presigned access for one exact artifact or checkpoint key. Cleanup deletion remains a trusted control-plane operation. Do not add bucket-prefix permissions to the shared task role. Both buckets deny requests that do not use TLS.

The signing endpoint, safe archive extraction, checkpoint upload and restore, and metadata reporting are future platform work. The completed hosted validation covers the scoped React scenario runner, not a full interactive learner session.

## Production Terraform state

Local Terraform state is allowed only for a disposable validation stack. Production must use an independently bootstrapped S3 state bucket with versioning, encryption, public access blocking, restricted operator access, and native S3 lockfiles.

After an operator creates that bootstrap bucket outside this stack, configure production state:

```sh
cp infra/aws/terraform/backend.production.tf.example \
  infra/aws/terraform/backend.production.tf
cp infra/aws/terraform/production.s3.tfbackend.example \
  infra/aws/terraform/production.s3.tfbackend
```

Replace the bucket name, then initialize with migration enabled:

```sh
terraform -chdir=infra/aws/terraform init \
  -migrate-state \
  -backend-config=production.s3.tfbackend
```

The backend bucket is deliberately outside this stack so destroying runner infrastructure cannot destroy its own state or lock. Never commit the generated backend files, which can contain environment-specific details.

## Destroy a validation stack

```sh
terraform -chdir=infra/aws/terraform destroy \
  -var=environment=validation \
  -var=ecr_force_delete=true \
  -var=runner_image_uri='<the deployed image URI>'
```

Production artifact data is not configured for forced deletion. Empty or retain required data before destroying a production stack.
