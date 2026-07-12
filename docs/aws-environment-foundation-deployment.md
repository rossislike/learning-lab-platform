# AWS environment foundation deployment evidence

Staging and production hosted-runner foundations were deployed in `us-east-2`
on 2026-07-12. Staging was created and qualified before production was planned
or applied.

## Temporary account exception

At the repository owner's direction, both environments currently use AWS
account `442359104502` through the default AWS CLI profile. They retain separate
Terraform state keys, VPC CIDRs, resource names, KMS keys, ECR repositories,
S3 buckets, ECS clusters, task definitions, IAM roles, and log groups.

This is the approved temporary exception recorded in
[`config/hosted-environments.json`](../config/hosted-environments.json). It
expires on 2026-08-12. Production learner traffic remains blocked while Clerk
applications and Convex deployments are not isolated. This is a procedural
release gate, not an AWS traffic kill switch.

## Immutable artifact promotion

The ARM64 hosted validation image was built from
`runner/hosted-validation.Dockerfile`, pushed to the immutable staging ECR
repository, and qualified in a private-subnet Fargate task. The same image
content was then promoted to the immutable production repository.

- Image digest: `sha256:c41aa11a664c9b5599dbefe2c2134be8a9dce48a8fd3da8084afd75dd2ca221c`
- Staging tag: `staging-20260712-foundation`
- Production tag: `production-20260712-foundation`
- Architecture: ARM64

The staging task exited with code `0`. Its CloudWatch log recorded the expected
starter failure, solution application, and passing solution check for the
`react-welcome-message` scenario. The TTL safety net stopped the already
successful task after its supplied expiry time.

## Deployed boundaries

| Resource | Staging | Production |
| --- | --- | --- |
| VPC CIDR | `10.52.0.0/16` | `10.62.0.0/16` |
| ECS cluster | `learning-lab-platform-staging` | `learning-lab-platform-production` |
| Artifact bucket | `llp-19c53dd152-staging-442359104502-us-east-2-a` | `llp-19c53dd152-production-442359104502-us-east-2-a` |
| Checkpoint bucket | `llp-19c53dd152-staging-442359104502-us-east-2-c` | `llp-19c53dd152-production-442359104502-us-east-2-c` |
| Data KMS key | `52f444c0-558b-4389-b021-ce96405648aa` | `a23fb9d3-3599-41ae-b5af-8dcc24cf33a9` |
| Task definition | `learning-lab-platform-staging-runner:1` | `learning-lab-platform-production-runner:1` |

Each VPC spans `us-east-2a` and `us-east-2b`, with private session subnets and
one NAT gateway per availability zone. Both ECS clusters are active with
Container Insights enabled. ECR uses immutable tags and KMS encryption. The S3
artifact and checkpoint buckets use their environment KMS key, S3 Bucket Keys,
public-access blocking, TLS-only bucket policies, and protected Terraform
resource addresses. Their policies also reject explicit non-KMS encryption and
explicit KMS keys other than the environment key. Requests without encryption
headers use the bucket's default environment KMS key.

## Convergence

The initial complete plans each contained 49 additions, no changes, and no
destroys after their KMS and ECR bootstrap. Both post-deployment Terraform plans
reported no changes. Production was not used to serve learner traffic or run a
production task.
