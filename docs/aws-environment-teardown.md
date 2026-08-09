# AWS hosted environment teardown

This runbook removes a staging or production hosted-runner environment while
keeping its Terraform backend available for recovery. Teardown is destructive
and must run in a maintenance window with no concurrent Terraform operations.

Terraform does not permit `prevent_destroy` to depend on a variable. The
teardown command therefore creates a temporary, ignored override inside the
shared hosted-runner module. The override also temporarily removes the scenario
artifact deletion deny so retained object versions can be emptied. An ignored
ownership manifest atomically binds that shared override to one environment and
AWS account. Every later phase verifies that ownership and refuses
cross-environment or cross-account use.

## 1. Approve and preserve

Record the change approval and reason. Confirm that the environment is no
longer serving users. Export the final Terraform state and copy any artifacts,
checkpoints, logs, or images that retention policy requires.

```sh
terraform -chdir=infra/aws/environments/staging state pull > /secure/path/staging-final.tfstate
npm run infra:teardown -- audit staging --account=442359104502
```

Use `production` in place of `staging` for the production environment. Never
store exported state in the repository.

## 2. Quiesce workloads and retained data

Stop active learner tasks and scale managed ECS services to zero. Identify every
artifact and checkpoint version or delete marker that must be removed, but do
not attempt to delete protected scenario objects before the prepare phase.
Delete all images from the environment runner and egress-proxy ECR repositories,
plus the trusted dispatcher and session gateway repositories. The plan phase
checks running and pending ECS tasks, service counts, all S3 object versions and
delete markers, and ECR image inventories. It refuses to create a destroy plan
until every check is clear.

Do not delete Route 53 records, certificates, load balancers, KMS keys, or
other Terraform-managed resources manually.

## 3. Prepare protections

The prepare phase verifies the active AWS account, creates the temporary
override, and uses a targeted apply to disable deletion protection on both
environment load balancers and temporarily update the artifact bucket policy.

```sh
npm run infra:teardown -- prepare staging \
  --account=442359104502 \
  --confirm='prepare teardown staging in 442359104502'
```

After prepare succeeds, empty every version and delete marker from the artifact
and checkpoint buckets. Scenario object deletion is allowed only while the
owned teardown override remains active. Continue directly to plan, or use abort
to restore the deletion deny and normal resource protections.

If prepare fails, the command removes the override and reapplies the normal
configuration to restore load balancer deletion protection and the scenario
artifact deletion deny. It removes the
ownership manifest only after that restoration succeeds. If restoration also
fails, ownership and the override remain in place so a later abort can retry
safely. Do not edit state or bypass the account guard.

To stop after a successful prepare, restore normal protections and remove all
temporary teardown files:

```sh
npm run infra:teardown -- abort staging \
  --account=442359104502 \
  --confirm='abort teardown staging in 442359104502'
```

## 4. Save and inspect the destroy plan

```sh
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

## 5. Apply the saved plan

```sh
npm run infra:teardown -- apply staging \
  --account=442359104502 \
  --confirm='destroy staging in 442359104502'
```

The data KMS key enters its configured 30-day deletion window. Keep the final
state export and operational evidence according to retention policy.

## 6. Remove the temporary override

Cleanup refuses to remove the override while the selected state still contains
managed resources.

```sh
npm run infra:teardown -- cleanup staging --account=442359104502
```

Confirm that `infra/aws/modules/hosted-runner/teardown_override.tf` and
`infra/aws/modules/hosted-runner/.teardown-owner.json` no longer exist before
any other Terraform work. Cleanup also removes the saved plan and its digest
metadata. If state still contains resources, cleanup refuses and directs the
operator to abort if the teardown will not continue.

## 7. Remove the backend last

The backend is a separate stack with its own `prevent_destroy` safeguards. Keep
it until every environment using it is gone, final state exports have been
tested, and the retention period has expired. Backend removal requires its own
reviewed change to remove `prevent_destroy`, empty every state-object version
and lock file, destroy the bootstrap stack, and retain evidence of the final
state and KMS deletion schedule.

Never remove the backend as part of the hosted environment destroy plan.
