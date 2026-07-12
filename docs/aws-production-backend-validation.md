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

## Independent backup restore rehearsal

The full state restoration procedure was rehearsed on 2026-07-12 without
changing the canonical backend. The rehearsal used Terraform `1.14.7`, AWS
provider `6.54.0`, account `442359104502`, and the authenticated `devAdmin`
operator.

The source was canonical S3 version
`umsC.kX3F5HJEPTEH72JBlmIYFHs5Szv`, with lineage
`74adb5c5-2c2c-c235-9148-c3ddb5f7cadb`, serial `2`, ETag
`874f6cf792526ef2f7831a078ffd4f28`, size `24,782` bytes, 10 resources,
and 10 resource instances. The canonical object head remained on that exact
version, ETag, and size throughout both restore exercises.

First, the selected version was restored under an isolated key in the state
bucket. A clean Terraform directory initialized against that key, listed the
same 10 objects, and produced a no-change refresh plan. The isolated state and
all historical lock versions and delete markers were then removed.

Second, the selected version was copied into the separate temporary S3 bucket
`llp-tfstate-restore-442359104502-20260712`, with versioning, full
public-access blocking, and the production KMS key. The backup object version
was `6WuIupXfSYR36yU6Ow9ueTgMIJ64xGsa`, with ETag
`e35039d1fc215dc4663641eabdaa204f` and size `24,782` bytes. A second clean
Terraform directory initialized directly against that independent bucket and
reported:

- lineage `74adb5c5-2c2c-c235-9148-c3ddb5f7cadb`;
- serial `2`;
- Terraform version `1.14.7`;
- 10 resources and 10 resource instances;
- a full refresh plan with no changes.

After validation, the backup state version, lock version, and lock delete
marker were permanently removed, followed by the temporary bucket. A final
`HeadBucket` returned `404 Not Found`. The canonical recovery prefix also
remains empty.

This proves that an encrypted state backup in an independent bucket can be
used by Terraform to reconstruct and refresh the production resource graph
without replacing or modifying the canonical state object.

The production KMS key was not disabled or scheduled for deletion during this
validation. That would create unnecessary risk to the live state backend. A
future break-glass exercise must rehearse disable and re-enable behavior with
an isolated key and copied state before applying the procedure to production.
