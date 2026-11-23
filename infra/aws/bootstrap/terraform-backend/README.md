# Terraform backend bootstrap

This stack creates the remote Terraform backend used by the other roots:

- a private, versioned S3 bucket for state and native `.tflock` files;
- a customer-managed KMS key with rotation enabled;
- public-access blocking, bucket-owner-enforced ownership, and TLS-only access;
- Terraform destruction protection on the bucket and KMS key.

DynamoDB locking is intentionally not used. Terraform 1.10 and newer use the
S3 backend's native lock file through `use_lockfile = true`.

## Bootstrap

The S3 bucket cannot be its own backend until it exists. The committed initial
configuration intentionally has no backend block, so the first `init` and
`apply` use local state reproducibly. Confirm the active identity and account
before applying:

```sh
aws sts get-caller-identity
```

Set `expected_aws_account_id` to that intended account ID. The AWS provider's
`allowed_account_ids` guard rejects credentials for any other account.

```sh
cp infra/aws/bootstrap/terraform-backend/terraform.tfvars.example \
  infra/aws/bootstrap/terraform-backend/terraform.tfvars

terraform -chdir=infra/aws/bootstrap/terraform-backend init
terraform -chdir=infra/aws/bootstrap/terraform-backend apply
```

Record the backend values without putting credentials in files:

```sh
terraform -chdir=infra/aws/bootstrap/terraform-backend output runner_backend_config
terraform -chdir=infra/aws/bootstrap/terraform-backend output bootstrap_backend_config
```

Only after the bucket exists, copy `backend.tf.example` to the ignored
`backend.tf`. Copy `bootstrap.s3.tfbackend.example` to the ignored
`bootstrap.s3.tfbackend`, replace the bucket, allowed account, and KMS
placeholders with those outputs, then back up and migrate the bootstrap state:

```sh
cp infra/aws/bootstrap/terraform-backend/backend.tf.example \
  infra/aws/bootstrap/terraform-backend/backend.tf
cp infra/aws/bootstrap/terraform-backend/bootstrap.s3.tfbackend.example \
  infra/aws/bootstrap/terraform-backend/bootstrap.s3.tfbackend
cp infra/aws/bootstrap/terraform-backend/terraform.tfstate \
  infra/aws/bootstrap/terraform-backend/terraform.tfstate.pre-migration-backup
terraform -chdir=infra/aws/bootstrap/terraform-backend init \
  -migrate-state \
  -backend-config=bootstrap.s3.tfbackend
```

Keep the local backup outside source control until migration is verified. Run
`terraform state pull` and compare its lineage, serial, and resource addresses
with the backup. Then run `terraform plan`; it must report no changes. Confirm
that both the state object and a `.tflock` object can be written while a plan is
running, and that the bucket owns both objects. Remove the local backup only
after these checks and a separately stored recovery copy are complete.

The `dev` environment root (`infra/aws/environments/dev`, Phase 5) uses this
backend with the state key recorded in `config/aws-terraform-backends.json`.
Fill its `dev.s3.tfbackend` from the `runner_backend_config` output, and use
`-migrate-state` only when an existing local state must be moved.

## Lock and encryption behavior

Every object write is denied unless it requests `aws:kms` with this stack's
exact KMS key ARN. The backend examples set `kms_key_id`, so Terraform applies
those headers to both state and native `.tflock` writes. They also set
`allowed_account_ids`, which makes backend initialization fail if the active
AWS credentials resolve to any other account.

## Required operator permissions

The operator or CI role using the backend needs narrowly scoped permissions:

- `s3:ListBucket` on the backend bucket for the configured state prefixes;
- `s3:GetObject` and `s3:PutObject` on each state object;
- `s3:GetObject`, `s3:PutObject`, and `s3:DeleteObject` on each `.tflock` object;
- `kms:Encrypt`, `kms:Decrypt`, `kms:GenerateDataKey`, and `kms:DescribeKey` on the state KMS key.

Do not grant `s3:DeleteObject` for state objects. S3 versioning is a recovery
control, not permission to overwrite state outside Terraform. The one
exception is the [Teardown](#teardown) below, which needs an administrator
identity.

## Recovery and operations

Before backend changes, Terraform upgrades, or infrastructure releases, save
an encrypted `terraform state pull` copy in an access-controlled backup
location separate from this bucket. Record the state lineage, serial, current
S3 version ID, Terraform version, provider lock file, KMS key ARN, and operator.
Periodically restore into an isolated test prefix and run `terraform plan` to
prove that backups and KMS access remain usable.

To recover an earlier S3 version, first stop all Terraform writers and save the
current version. Inspect versions with `aws s3api list-object-versions`. Copy
the selected prior version to a new temporary key, inspect it with
`terraform state pull` from an isolated backend configuration, and confirm its
lineage and serial. Only then copy that version over the canonical state key,
retain every version, reinitialize, and require a no-surprise plan before any
apply. Never delete state versions as part of recovery.

Use `terraform force-unlock LOCK_ID` only after proving that no plan or apply is
running in local processes, CI, or another operator session. Inspect the
`.tflock` object and contact the recorded owner first. Preserve a copy of the
lock object for the incident record, use the exact lock ID, then run a fresh
plan. Never delete a `.tflock` object directly as the first response.

The KMS key has rotation enabled and a 30-day deletion window with Terraform
destruction protection. Monitor key disablement and scheduled deletion. If the
key is disabled, stop Terraform operations and have a break-glass KMS
administrator re-enable it. If deletion is scheduled, cancel deletion before
the window expires. Test decrypt access to a copied state version before
resuming. If the key is permanently lost, the encrypted state versions cannot
be recovered, so account-level KMS controls and independently tested state
backups are required.

## Teardown

Destroy this stack last, after every root that keeps state in the bucket
(`environments/dev`, `account-security`) has been destroyed and its state is
empty. It was last destroyed on 2026-11-23. The bucket holds this stack's
own state, so move that back to a local file first:

1. Keep a backup outside the repository, delete the ignored `backend.tf`,
   and migrate. Terraform
   asks whether to copy the existing state to the local backend; answer
   `yes`. Then check that the local state holds the bucket and the key:

   ```sh
   terraform -chdir=infra/aws/bootstrap/terraform-backend state pull > ~/bootstrap-state-backup.json
   rm infra/aws/bootstrap/terraform-backend/backend.tf
   terraform -chdir=infra/aws/bootstrap/terraform-backend init -migrate-state
   terraform -chdir=infra/aws/bootstrap/terraform-backend state list
   ```

   This only works where `.terraform/` still remembers the S3 backend. On a
   fresh clone, first recreate `backend.tf` and `bootstrap.s3.tfbackend`
   from their examples ([Bootstrap](#bootstrap)) and run
   `init -backend-config=bootstrap.s3.tfbackend`, then start this step. Do
   not go on if `state list` is empty: a destroy against empty state removes
   nothing and reports success.

2. In a working copy only (do not commit this), set both
   `prevent_destroy = true` in `main.tf` to `false` and add
   `force_destroy = true` to `aws_s3_bucket.terraform_state`, then record the
   bucket change in state so the destroy may empty the versioned bucket (the
   bucket policy denies writes without the stack's KMS key, but not deletes):

   ```sh
   terraform -chdir=infra/aws/bootstrap/terraform-backend apply -target=aws_s3_bucket.terraform_state
   ```

3. Destroy, then restore `main.tf` and clean up the local leftovers:

   ```sh
   terraform -chdir=infra/aws/bootstrap/terraform-backend destroy
   git checkout -- infra/aws/bootstrap/terraform-backend/main.tf
   rm infra/aws/bootstrap/terraform-backend/terraform.tfstate* \
     infra/aws/bootstrap/terraform-backend/bootstrap.s3.tfbackend
   ```

   Also delete the ignored `account-security.s3.tfbackend` and
   `dev.s3.tfbackend` in the other two roots, or remember to refill them:
   they name the KMS key that is now going away.

This permanently deletes every stored state version. The KMS key is scheduled
for deletion after 30 days. The next bootstrap starts from
[Bootstrap](#bootstrap) with no backend block, like the first one, but it
creates a new KMS key; what has to be updated for that is listed under
[Bringing it back](../../README.md#bringing-it-back).
