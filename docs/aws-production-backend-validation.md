# AWS production Terraform backend validation

The production Terraform backend was deployed and validated on 2026-07-12 in
AWS account `442359104502`, region `us-east-2`.

## Deployed boundary

- S3 bucket: `learning-lab-platform-production-tfstate-442359104502-us-east-2`
- KMS alias: `alias/learning-lab-platform-production-terraform-state`
- Bootstrap state key: `learning-lab-platform/production/bootstrap/terraform.tfstate`
- Runner state key: `learning-lab-platform/production/terraform.tfstate`
- Locking: native S3 `.tflock` objects with `use_lockfile = true`

The bootstrap state tracks the KMS key and alias, S3 bucket, versioning,
encryption, ownership controls, public-access block, and bucket policy. The
runner backend is configured and reserved at its separate key. Its previous
local state was empty, so no runner resources required migration. S3 does not
contain a runner state object yet because backend initialization does not write
state. Terraform will create that object on the first state-writing operation.

## Validation evidence

The following checks passed:

- The saved deployment plan contained 8 additions, 0 changes, and 0 destroys.
- The post-deployment plan reported no infrastructure changes.
- S3 versioning is enabled and all four public-access-block settings are true.
- State and live `.tflock` objects report `aws:kms` encryption with the
  designated production KMS key and S3 bucket keys enabled.
- KMS reports the key enabled for encrypt/decrypt use with automatic rotation.
- A refresh-only apply held the native lock while a concurrent plan failed
  with S3 `PreconditionFailed` and the active Terraform lock metadata.
- A plan succeeded after the first process released the lock normally.
- The pre-migration backup and remote state contain the same 10 resource
  addresses. Backend migration established a new remote lineage, so resource
  identity was compared rather than assuming lineage would remain unchanged.
- A selected version of the canonical state object was copied to an isolated
  recovery key, downloaded successfully through KMS, and matched the current
  remote lineage and resource set exactly.
- Every temporary recovery object version was deleted after validation.

The version-copy exercise proved that an earlier object version can be copied,
decrypted, downloaded, and compared with the canonical state. It did not run
Terraform against a fully isolated restored backend. That full restoration
rehearsal remains an open roadmap task.

The production KMS key was not disabled or scheduled for deletion during this
validation. That would create unnecessary risk to the live state backend. A
future break-glass exercise must rehearse disable and re-enable behavior with
an isolated key and copied state before applying the procedure to production.
