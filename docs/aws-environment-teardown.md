# AWS hosted environment teardown

This runbook removes a staging or production hosted-runner environment while
keeping its Terraform backend available for recovery. Teardown is destructive
and must run in a maintenance window with no raw or concurrent Terraform
operations.
The account-security stack, Clerk DNS records, and external Clerk and Convex
resources are outside both environment roots and must remain in place.

Terraform does not permit `prevent_destroy` to depend on a variable. The
teardown command therefore creates a temporary, ignored override inside the
shared hosted-runner module. The override also temporarily removes the scenario
artifact deletion deny so retained object versions can be emptied. An ignored
ownership manifest atomically binds that shared override to one environment and
AWS account. Every later phase verifies that ownership and refuses
cross-environment or cross-account use.

Every supported hosted Terraform and teardown command also validates the three
canonical S3 backend identities and the `default` Terraform workspaces. It then
holds one conditional S3 operation lock while it reads or changes state. This
coordinates the repository wrappers across Terraform roots and machines. Raw
Terraform commands do not honor that operation lock and are not an atomic
alternative to these workflows.

Run `npm install` before using the guarded wrappers. The synchronous wrappers
delegate lock requests to `scripts/s3-operation-lock-helper.mjs`, which uses
the installed `@aws-sdk/client-s3` service model for conditional S3 writes and
deletes. AWS CLI 2.14.5, the current operational runtime, does not expose the
required `PutObject IfNoneMatch` or `DeleteObject IfMatch` inputs, so the lock
must not be rewritten as `aws s3api` commands using those flags.

If lock acquisition reports another active operation, stop and identify that
operator or process. A terminated process can leave the lock object behind.
Remove a stale lock only through an approved recovery after confirming that no
hosted plan, apply, teardown, or shared-alarm operation is running in any
checkout.

## 1. Approve and preserve

Record the change approval and reason. Confirm that the environment is no
longer serving users. Export the final Terraform state and copy any artifacts,
checkpoints, logs, or images that retention policy requires.

```sh
AWS_PROFILE=default terraform -chdir=infra/aws/environments/staging state pull > /secure/path/staging-final.tfstate
AWS_PROFILE=default npm run infra:teardown -- audit staging --account=442359104502
```

Use `production` in place of `staging` for the production environment. Never
store exported state in the repository.

## 2. Quiesce workloads and retained data

Stop active learner tasks and scale managed ECS services to zero. Identify every
artifact and checkpoint version or delete marker that must be removed, but do
not attempt to delete protected scenario objects before the prepare phase.
Delete all images from the environment runner and egress-proxy ECR repositories,
plus the trusted dispatcher and session gateway repositories. The plan phase
checks running and pending ECS tasks, service counts, all artifact, checkpoint,
and ALB access-log object versions and delete markers, and ECR image inventories.
It refuses to create a destroy plan until every check is clear.

Do not delete Route 53 records, certificates, load balancers, KMS keys, or
other Terraform-managed resources manually.

## 3. Prepare protections

The prepare phase verifies the active AWS account, creates the temporary
override, and uses a targeted apply to disable deletion protection on both
environment load balancers, disable public ALB access-log delivery, and
temporarily update the artifact bucket policy. It verifies the ALB attribute
after the apply and records when delivery was disabled in the ownership
manifest.

```sh
AWS_PROFILE=default TF_VAR_github_repository=rossislike/learning-lab-platform \
  npm run infra:teardown -- prepare staging \
  --account=442359104502 \
  --confirm='prepare teardown staging in 442359104502'
```

After prepare succeeds, preserve any required ALB logs and wait at least 10
minutes for pending access-log deliveries. Then empty every version and delete
marker from the artifact, checkpoint, and ALB access-log buckets. The guarded
plan enforces the 10-minute drain interval and checks the ALB attribute again
before inspecting the bucket. Scenario object deletion is allowed only while
the owned teardown override remains active. Continue directly to plan, or use
abort to restore the deletion deny, ALB logging, and normal resource
protections.

If prepare fails, the command removes the override and reapplies the normal
configuration to restore load balancer deletion protection, ALB logging, and
the scenario artifact deletion deny. It removes the
ownership manifest only after that restoration succeeds. If restoration also
fails, ownership and the override remain in place so a later abort can retry
safely. Do not edit state or bypass the account guard.

To stop after a successful prepare, restore normal protections and remove all
temporary teardown files:

```sh
AWS_PROFILE=default TF_VAR_github_repository=rossislike/learning-lab-platform \
  npm run infra:teardown -- abort staging \
  --account=442359104502 \
  --confirm='abort teardown staging in 442359104502'
```

## 4. Save and inspect the destroy plan

```sh
AWS_PROFILE=default TF_VAR_github_repository=rossislike/learning-lab-platform \
  npm run infra:teardown -- plan staging \
  --account=442359104502 \
  --confirm='plan teardown staging in 442359104502'
```

Inspect the saved plan before continuing:

```sh
terraform -chdir=infra/aws/environments/staging show .terraform/staging-destroy.tfplan
```

The plan must affect only the selected environment. It must not include the
Terraform backend bucket or backend KMS key.

The command removes stale plan files before planning, then records the plan's
SHA-256 digest, environment, and account in ignored metadata. Apply refuses a
missing or modified plan and refuses metadata owned by another environment or
account. Apply also repeats the complete workload and retained-data preflight
immediately before using the saved plan, closing the gap between planning and
destruction. Any new plan replaces the prior plan and integrity metadata.

If an apply destroys only part of the environment, leave the ownership
manifest and override in place. Empty any retained resource that caused the
failure, then run the same guarded plan command again and inspect the new saved
plan. The owner inventory lets preflight skip only monitored resources that are
no longer in Terraform state. It still validates every monitored resource that
remains. Do not use direct Terraform commands to bypass this recovery path.
Abort refuses a partial destroy because restoring the normal configuration
could recreate resources.

## 5. Apply the saved plan

```sh
AWS_PROFILE=default TF_VAR_github_repository=rossislike/learning-lab-platform \
  npm run infra:teardown -- apply staging \
  --account=442359104502 \
  --confirm='destroy staging in 442359104502'
```

The data and service-secrets KMS keys enter their configured 30-day deletion
windows. The dispatcher secret enters its configured 30-day recovery window.
Keep the final state export and operational evidence according to retention
policy.

## 6. Clean up the environment and shared alarms

Cleanup refuses to remove the override while the selected state still contains
managed resources.

```sh
AWS_PROFILE=default npm run infra:teardown -- cleanup staging --account=442359104502
```

Confirm that `infra/aws/modules/hosted-runner/teardown_override.tf` and
`infra/aws/modules/hosted-runner/.teardown-owner.json` no longer exist before
any other Terraform work. Cleanup also removes the saved plan and its digest
metadata. If state still contains resources, cleanup refuses and directs the
operator to continue through guarded plan and apply. Abort is available only
before destruction starts.

If the other hosted environment still has managed resources, cleanup retains
the shared alarms. When both canonical environment states are empty, cleanup
automatically removes the exact 12 Terraform-owned
`learning-lab-platform-*` CloudWatch alarms from the retained account-security
root. It changes the tracked alarm lifecycle setting to `false`, applies only
an inspected alarm plan, and verifies both Terraform state and CloudWatch in
the effective account-security region. The account CloudTrail, metric filters,
SNS topic, GuardDuty routing, GitHub OIDC provider, and Terraform backend remain.

If alarm removal fails, cleanup preserves the environment teardown ownership
files so the same cleanup command can retry. Use the standalone recovery
command only when both states are empty and teardown ownership metadata is no
longer available:

```sh
AWS_PROFILE=default npm run infra:teardown:shared-alarms -- \
  --account=442359104502 \
  --confirm='destroy shared learning-lab alarms in 442359104502'
```

The alarm workflow refuses alternate workspaces or backend identities, an
active hosted operation, nonempty environment state, unexpected alarm instance
keys or names, and a replaced saved plan. The inspected plan is uniquely named
and bound to apply by SHA-256. Alarm deletion protection is disabled only by a
temporary ignored Terraform override during this guarded operation.

## 7. Retain the backend

The backend is a separate stack with its own `prevent_destroy` safeguards. Keep
it available for the retained final state exports and future reprovisioning.
Any future backend removal requires its own approved and reviewed change. It is
not part of environment teardown.

Never remove the backend as part of the hosted environment destroy plan.
