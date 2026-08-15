# AWS production operations

This runbook defines who owns each hosted environment, how operators access
production, how emergency access works, how service secrets rotate, and how
production changes are approved and applied. It applies to staging and
production hosted runner environments.

Production learner traffic remains blocked until all roadmap production gates
are complete. These procedures still apply to production infrastructure,
security controls, and any dry-run or validation activity in the production
account.

## Ownership

Each hosted environment has one accountable owner, a backup who can assume the
role during absence or an incident, and a defined escalation route:

| Environment | Accountable owner | Backup | Escalation route |
| --- | --- | --- | --- |
| Staging | Infrastructure operator | Application operator | Escalate unresolved availability, data, security, or promotion blockers to the platform owner. Include the security operator for any control or credential concern. |
| Production | Platform owner | Infrastructure operator | Notify the platform owner and security operator immediately for a customer, security, data, recovery, or cost incident. The infrastructure operator leads technical containment unless the incident owner assigns another operator. |

The accountable owner decides environment readiness, ensures operational work
has an assigned operator, and confirms that unresolved risks follow the stated
escalation route. The backup has the same responsibility while acting for the
accountable owner. Technical responsibilities remain divided as follows:

| Area | Owner | Responsibilities |
| --- | --- | --- |
| Platform product | Platform owner | Approves roadmap scope, production traffic enablement, learner data retention, and product rollback decisions. |
| AWS infrastructure | Infrastructure operator | Maintains Terraform state, networking, ECS, ECR, S3, KMS, CloudWatch, WAF, Route 53, and ACM resources. |
| Security controls | Security operator | Reviews IAM, secret access, WAF, CloudTrail, GuardDuty, alarm routing, and emergency access use. |
| Identity and data plane | Application operator | Maintains Clerk applications, Convex deployments, JWT issuer configuration, schema promotion, and learner data backups. |
| Scenario artifacts | Scenario author or release operator | Publishes reviewed scenario manifests and immutable artifacts after validation. |

One person may hold more than one role in the current project stage, but the
approval record for a production change must state which responsibility they
are acting under. A production change that weakens IAM, network boundaries,
encryption, route authorization, logging, or deletion protection requires
security operator review even when the same person is also the infrastructure
operator.

## Normal operator access

The current operator workflow uses the AWS CLI `default` profile for the shared
account. Do not create separate staging and production AWS profiles. The
credential details and preferred migration to short-lived IAM Identity Center
sessions are documented in
[`aws-service-credential-boundary.md`](aws-service-credential-boundary.md).

Before any hosted Terraform plan, apply, secret rotation, image promotion, or
manual recovery, verify the active AWS identity and account:

```sh
AWS_PROFILE=default aws sts get-caller-identity
```

For hosted environment Terraform and Convex changes, use the guarded npm
commands documented in
[`environment-isolation.md`](environment-isolation.md). Direct Terraform
`init` is also permitted for the backend initialization and backendless source
validation commands documented in
[`infra/aws/environments/README.md`](../infra/aws/environments/README.md).
Other direct Terraform or Convex CLI invocation is allowed only for read-only
inspection or when a documented incident procedure explicitly requires it.
Hosted image delivery uses the GitHub Actions workflow documented in
[`hosted-image-delivery.md`](hosted-image-delivery.md).

## Emergency access

Emergency access is limited to incidents where normal access is unavailable or
too slow to prevent material customer, security, data, or cost impact. Examples
include compromised credentials, runaway infrastructure cost, exposed learner
routes, unavailable production state, or failed cleanup that leaves managed
tasks running.

Emergency access procedure:

1. Open or record an incident with start time, operator, reason, affected
   environment, and expected command scope.
2. If IAM Identity Center is available, use the `awsAdmin` temporary session
   for the smallest action required to stabilize the incident.
3. If IAM Identity Center is unavailable, use one of two individually assigned
   break-glass IAM users in the affected AWS account. Each user must have no
   access keys, a unique vaulted console password, hardware MFA, and permission
   only to assume the monitored emergency administrator role. Password access
   requires approval from both the platform owner and security operator. The
   password vault and hardware MFA devices must have separate custodians.
4. Preserve evidence before changing state when doing so does not increase
   impact. At minimum, capture relevant CloudWatch alarm state, ECS task or
   service state, Terraform state version IDs, and CloudTrail event times.
5. Do not manually delete Terraform-managed resources unless the incident
   requires immediate containment and the planned Terraform path cannot act
   quickly enough.
6. After stabilization, run a Terraform refresh plan for the affected root,
   reconcile drift, rotate any credentials exposed to the emergency path, and
   record follow-up fixes. Sign out all emergency sessions, disable the used
   break-glass user, rotate its password, and replace or re-enroll its MFA
   device if custody may have been compromised. The security operator may
   re-enable the user only after the incident review is complete.

CloudTrail and an EventBridge alarm must alert the platform owner and security
operator on every break-glass console login, failed login, emergency role
assumption, and authorization change. The security operator tests each
break-glass identity quarterly by signing in, assuming the emergency role,
performing one read-only identity check, signing out, and confirming the alert
and audit record. The test record includes the date, participants, CloudTrail
event IDs, alert evidence, and any remediation. Break-glass credentials must
never be used for routine work.

Break-glass use of KMS, IAM, Secrets Manager, CloudTrail, GuardDuty, WAF, or
Terraform state requires a post-incident review before the next production
deployment. The review must confirm whether any control was weakened, whether
logs remained intact, and whether credentials or bootstrap codes require
revocation.

## Secret rotation

Terraform owns secret containers, KMS keys, and access policy. Terraform does
not own or store plaintext secret values. Secret rotation is a coordinated
production change, not an ad hoc console edit.

The security operator is accountable for the secret rotation register and
reviews it weekly for secrets due within 30 days or already overdue. The
application operator owns application, callback, Clerk, and Convex secrets.
The infrastructure operator owns AWS service integration and infrastructure
secrets. Every hosted service secret must rotate at least every 90 days, or on
a shorter provider or security policy interval. A longer interval requires a
documented exception with an expiry approved by both the platform owner and
security operator.

The register tracks the secret identifier, environment, owner, creation date,
last successful rotation, next due date, applicable interval, and verification
evidence without storing the value. An overdue production secret is a
production readiness failure. Notify its owner and the security operator on
the due date, open a remediation incident, and rotate it within one business
day. Until rotation succeeds or a time-limited exception is approved, only
production changes needed to remediate the secret or stabilize an incident may
proceed.

Rotate a hosted service secret with this sequence:

1. Confirm the target environment, secret ARN, KMS key ARN, Convex deployment,
   and affected services.
2. Generate a new high-entropy value without printing it or saving it in shell
   history.
3. Store the value in the environment-specific secret store that consumes it.
   For dispatcher shared credentials, update AWS Secrets Manager and the
   matching Convex environment as described in
   [`aws-service-credential-boundary.md`](aws-service-credential-boundary.md).
4. Restart or redeploy only the service that needs the new value.
5. Verify callbacks, health checks, and relevant logs without retrieving or
   printing the plaintext value.
6. Remove superseded values after the new version is proven healthy.
7. Record the secret name, environment, operator, verification evidence, and
   rollback path. Do not record the secret value.

Immediate rotation is required after suspected exposure, unexpected access
policy broadening, emergency access that could have viewed a value, accidental
logging, or a failed deployment that injected a production secret into a
non-production environment.

## Production change procedure

Production changes must be promoted from staging evidence. A production
deployment is not approved solely because local tests pass.

For each production change:

1. Define the change scope, affected environments, rollback plan, and expected
   user impact.
2. Confirm the staging equivalent has been deployed and qualified, or document
   why the change is production-only.
3. Run the relevant local verification commands for the changed source.
4. Run the guarded staging plan or deployment command first when the change
   affects hosted infrastructure, Convex schema or functions, images, scenario
   artifacts, or frontend assets.
5. Review the production plan, image digest, artifact digest, or deployment
   manifest before applying it. Production ECS task definitions and scenario
   artifacts must use immutable digests.
6. Obtain and record approval before apply. The platform owner or a delegated
   release approver may approve routine production changes. The approver must
   be different from the operator who applies the change and must confirm the
   staging evidence, reviewed production plan or manifest, rollback plan, and
   change window. Changes requiring security review also require security
   operator approval. If no independent approver is available, defer the
   change unless it qualifies for the emergency access procedure.
7. Apply through the guarded production command or the approved CI/CD workflow.
8. Verify alarms, health checks, logs, and user-facing behavior that map to the
   changed component.
9. Record the source commit, operator, approver, approval time and decision,
   commands, plan result, deployed digest or manifest, verification evidence,
   and rollback criteria.

Changes that modify security controls, IAM, KMS, WAF, routing authorization,
credential handling, environment isolation, deletion protection, state
backend settings, or learner data retention require explicit security review.

Do not enable production learner traffic until `npm run env:isolation:require-ready`
passes, the configured shared-account AWS boundaries are intact, staging and
production use separate Clerk applications and Convex deployments, and all
production readiness gates in the roadmap are complete.

## Rollback and recovery

Rollback must prefer the last known good immutable artifact, image digest,
frontend asset manifest, Convex function set, or Terraform state-preserving
configuration. Do not roll production back by copying staging data, reusing
development credentials, disabling authorization checks, or weakening network
boundaries.

Use the dedicated runbooks for specialized recovery:

- Hosted image delivery:
  [`hosted-image-delivery.md`](hosted-image-delivery.md)
- Terraform backend recovery:
  [`aws-production-backend-validation.md`](aws-production-backend-validation.md)
- Environment isolation gate:
  [`environment-isolation.md`](environment-isolation.md)
- Hosted environment teardown:
  [`aws-environment-teardown.md`](aws-environment-teardown.md)
- Service credential boundary:
  [`aws-service-credential-boundary.md`](aws-service-credential-boundary.md)
