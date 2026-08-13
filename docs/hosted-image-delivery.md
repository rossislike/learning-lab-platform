# Hosted image delivery

The hosted image workflow validates ARM64 images on pull requests, publishes
scanned and signed images to staging, and copies approved staging digests to
production without rebuilding them. It does not update ECS task definitions.

The roadmap item remains incomplete until external action references are pinned
to authenticated full commit SHAs and the OIDC roles are applied in isolated
staging and production accounts. The environment isolation gate currently
prevents that apply. Do not bypass the gate or mark the item complete early.

## Pull request checks

Pull requests build all four ARM64 images locally, fail on high or critical
Trivy findings, generate one SPDX JSON SBOM per image, and upload uniquely named
SBOM artifacts. The job has no AWS credentials, OIDC token permission, image
push, or signing permission.

Configure these repository variables for the learner image build:

| Variable | Purpose |
| --- | --- |
| `OPENVSCODE_SERVER_VERSION` | Reviewed OpenVSCode Server release |
| `OPENVSCODE_SERVER_SHA256` | SHA256 of its ARM64 release archive |

## AWS authentication

Each isolated environment root calls
`infra/aws/modules/github-image-delivery`. The module creates a GitHub OIDC
provider and an environment-bound role with access only to that environment's
four ECR repositories. Staging also creates a read-only role that a production
environment job can use to pull approved staging digests.

After the isolation gate passes, apply the staging and production roots through
the guarded commands and configure these environment secrets from Terraform
outputs:

| GitHub environment | Secret | Terraform output |
| --- | --- | --- |
| `staging` | `AWS_STAGING_IMAGE_DELIVERY_ROLE_ARN` | staging `image_delivery_role_arn` |
| `production` | `AWS_STAGING_IMAGE_PROMOTION_READ_ROLE_ARN` | staging `image_promotion_reader_role_arn` |
| `production` | `AWS_PRODUCTION_IMAGE_DELIVERY_ROLE_ARN` | production `image_delivery_role_arn` |

Both root variable files must set `github_repository` in `owner/name` form.
The trust policy accepts only GitHub environment identity subjects, not branch,
tag, or pull request subjects.

## GitHub environment controls

Create protected GitHub environments named `staging` and `production`. Restrict
both to the repository default branch. Production must require independent
reviewers, prevent self-review, and not allow administrators to bypass the
protection rule for routine releases.

The workflow checks the default branch and runs
`npm run env:isolation:require-ready` before requesting AWS credentials. After
role assumption, it verifies the caller account against
`config/hosted-environments.json`.

## Staging publication

Dispatch the workflow for `staging` from the default branch. Supply the image
scope, OpenVSCode Server release, and matching SHA256. Each selected image is:

1. Built for `linux/arm64` and pushed under a unique immutable tag.
2. Scanned at its digest with high and critical findings configured to fail.
3. Recorded in an SPDX JSON SBOM with a matrix-specific artifact name.
4. Signed with Cosign keyless signing and immediately verified against the
   workflow certificate identity and GitHub Actions OIDC issuer.
5. Added by digest to `hosted-image-promotion-manifest-staging`.

## Production promotion

Dispatch the workflow for `production` from the default branch and provide the
successful staging workflow run ID. The workflow verifies that the source run
used this workflow, succeeded on the default branch, and produced a valid
staging manifest. It logs into staging with the read-only role, logs into
production with the delivery role, copies each source manifest, and hashes the
raw destination manifest to prove that its digest is unchanged. It then signs
and identity-verifies each production digest before publishing
`hosted-image-promotion-manifest-production`.

Downstream deployment must use the manifest's exact `imageUri` values. It must
also verify each signature with:

```sh
cosign verify \
  --certificate-identity "https://github.com/OWNER/REPOSITORY/.github/workflows/hosted-image-delivery.yml@refs/heads/DEFAULT_BRANCH" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  "ACCOUNT.dkr.ecr.REGION.amazonaws.com/REPOSITORY@sha256:DIGEST"
```

Tags identify workflow runs only. They are not deployment inputs.
