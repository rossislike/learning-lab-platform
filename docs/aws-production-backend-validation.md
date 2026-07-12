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

## Isolated KMS disable and re-enable rehearsal

KMS failure and recovery were rehearsed on 2026-07-12 without changing the
production key or canonical state. The test used Terraform `1.14.7`, AWS
provider `6.54.0`, account `442359104502`, region `us-east-2`, and the
authenticated `devAdmin` operator. The temporary KMS key was
`arn:aws:kms:us-east-2:442359104502:key/5d4d7b7e-ae92-48ec-89e7-64e8c3aaa97c`,
and the temporary bucket was `llp-kms-recovery-442359104502-20260712`.

The canonical state version was copied into the private, versioned bucket and
encrypted only with the temporary key. The clean working directory
`/tmp/learning-lab-kms-recovery-20260712` initialized against the temporary
bucket and object key `backups/bootstrap-direct-kms.tfstate`. Its backend
configuration constrained the account to `442359104502`, selected
`us-east-2`, enabled encryption and native S3 lock files, and specified the
temporary KMS key. It restored lineage
`74adb5c5-2c2c-c235-9148-c3ddb5f7cadb`, serial `2`, and all 10 resource
instances, then produced a no-change refresh plan.

The first copy used S3 Bucket Keys. Immediately after disabling its KMS key,
S3 and Terraform could still read that object. A cached bucket-level data key
is the explanation consistent with this observed behavior, but the rehearsal
did not directly inspect the S3 cache. This means a KMS disablement alarm must
not assume that all S3 reads fail immediately when Bucket Keys are enabled.
The timing of the direct-KMS failure test below is deliberately deterministic
and can differ from production objects that use S3 Bucket Keys.

For a deterministic failure test, a second copy was encrypted with the same
temporary KMS key and S3 Bucket Keys disabled. `HeadObject` reported
server-side encryption `aws:kms`, the full temporary key ARN above, object
version `1riAELuih4lbcmmnZ002GM5Ky64Z.KXx`, ETag
`c809e02e54cbc2181d0883db51ac6c94`, and size `24,782` bytes.
`BucketKeyEnabled` was absent or null, which means it was not enabled for this
object. The sequence then proved:

1. State pull succeeded while the temporary key was enabled.
2. Disabling the temporary key changed it to `Disabled`.
3. Direct S3 retrieval failed with `KMS.DisabledException`.
4. Terraform state refresh failed with the same disabled-key error.
5. Re-enabling the key returned it to `Enabled`.
6. Terraform restored the original lineage, serial, and all 10 instances.
7. A full refresh plan again reported no changes.

The captured pre-check and post-check both reported production KMS key
`473fd4c0-6d38-4dc6-8a29-013b895a9eb2` as `Enabled`. The canonical object
pre-check and post-check both reported version
`umsC.kX3F5HJEPTEH72JBlmIYFHs5Szv`, ETag
`874f6cf792526ef2f7831a078ffd4f28`, and size `24,782` bytes. These checks show
that the production boundary was unchanged at the two recorded observation
points. They do not claim continuous observation during the rehearsal.

For reproducibility, the recorded command classes were AWS identity and region
checks; S3 bucket creation, versioning, public-access blocking, object copy,
`HeadObject`, retrieval, version listing, object-version deletion, and bucket
deletion; KMS key creation, description, disablement, enablement, and deletion
scheduling; and Terraform initialization, state pull, state inspection, and
refresh planning. Setup, enabled-key reads, re-enabled-key reads, restored
state inspection, the final no-change plan, and cleanup returned success.
Direct S3 retrieval and Terraform refresh while the direct-KMS key was disabled
returned the expected `KMS.DisabledException` failures.

Cleanup evidence records six successful object-version or delete-marker
removal calls and a successful delete-bucket call. No post-deletion
`HeadBucket` result was retained because the approval limit had been reached,
so this rehearsal does not claim an independently observed `404`. The temporary
key entered `PendingDeletion` with AWS deletion date
`2026-07-19T09:57:34.023000-04:00`.
