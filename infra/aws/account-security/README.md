# AWS account security

This Terraform root owns account-wide security controls for account
`442359104502`. It is instantiated exactly once and is not duplicated by the
`dev` environment root. `main.tf` provisions:

- a dedicated multi-region CloudTrail for all management events, with log
  file validation, a KMS-encrypted and versioned S3 bucket (365-day
  retention, TLS-only, public access blocked), and delivery to a CloudWatch
  log group
- twelve CloudTrail metric filters for high-risk account changes (root usage,
  denied API calls, console login without MFA, IAM/CloudTrail/CloudWatch/SNS/
  EventBridge/WAF/GuardDuty/KMS/security-group changes) and, when
  `enable_learning_lab_alarms` is `true`, a matching CloudWatch alarm per
  filter
- a KMS-encrypted SNS security alert topic with a required email subscription
- an EventBridge rule routing GuardDuty findings with severity 4 or higher to
  the topic
- an independent EventBridge rule routing mutations of the alert pipeline
  itself (CloudTrail, alarms, log groups, SNS, EventBridge, WAF, ALB logging)
  to the topic
- the single account-level GitHub Actions OIDC provider that delivery roles
  (`modules/github-deploy`, Phase 6) trust
- deployment checks: the active account must match
  `expected_aws_account_id`, and the pre-existing GuardDuty detector must be
  enabled with Runtime Monitoring and its ECS Fargate agent management
  configuration turned on. The ECS Fargate check is a leftover from the
  retired ECS plan (to be replaced by the EKS runtime agent check; see
  ROADMAP).

This root does not manage the GuardDuty detector itself or the pre-existing
`rumo-claims-trail`; it only validates the detector and routes its findings.

## Usage

Plain `terraform` commands are the supported path; there are no wrapper
scripts and no cross-root operation lock.

Copy `account-security.s3.tfbackend.example` to the ignored
`account-security.s3.tfbackend`, and `terraform.tfvars.example` to the ignored
`terraform.tfvars`. Replace the example values before applying.

```sh
AWS_PROFILE=default terraform -chdir=infra/aws/account-security init -backend-config=account-security.s3.tfbackend
AWS_PROFILE=default terraform -chdir=infra/aws/account-security plan
AWS_PROFILE=default terraform -chdir=infra/aws/account-security apply
```

IAM allows one OIDC provider per URL. If the GitHub provider is already in
the account (the 2026-11-23 teardown left it there, because roles of other
projects trust it), the apply fails with `EntityAlreadyExists` until it is
imported, after `init` and before `apply`:

```sh
AWS_PROFILE=default terraform -chdir=infra/aws/account-security import \
  aws_iam_openid_connect_provider.github_actions \
  arn:aws:iam::442359104502:oidc-provider/token.actions.githubusercontent.com
```

First find out whether another project's Terraform manages that provider. If
one does, do not import it (two states would own one resource); read it
through a data source in this root instead. After an import, review the plan:
the apply sets the thumbprint list, the client ID list and this project's
default tags on a provider other roles depend on.

`security_alert_email` is required so an apply cannot silently omit the
notification recipient or delete the confirmed subscription. AWS sends a
confirmation message when the endpoint changes; notifications do not reach the
new address until the recipient confirms. Terraform can verify that the
subscription is configured, but confirm delivery in SNS or with a test message.

Deploy this root before the `dev` environment root. `dev` resolves the alert
topic and the GitHub OIDC provider from this root, so its plan fails safely if
they do not exist. The topic, both KMS keys, the CloudTrail, its bucket, and
the alarms have `prevent_destroy = true`.

## Project alarms

The tracked `zz-learning-lab-alarms.auto.tfvars.json` is the single source for
`enable_learning_lab_alarms`; do not set it in the ignored `terraform.tfvars`.
It is `true` since Phase 6, so the twelve alarms exist whenever this root is
applied (it is not right now, see [Teardown](#teardown)). Because the alarms have
`prevent_destroy = true`, flipping it back to `false` requires removing that
lifecycle guard first.

Expect noise while the dev environment is rolled out: the IAM, CloudWatch,
SNS and security-group change alarms fire on the dev applies themselves
(new roles, alarms and topic; the Ingress-managed ALB's security groups), and
`AccessDenied` alarms on denied API calls from the new CI role while its
permissions settle. Read those notifications against the apply that caused
them rather than muting the topic.

## Teardown

This root is independent of `environments/dev`: destroying dev leaves the
CloudTrail, the metric filters, the twelve alarms and the alert topic
running, and the alarms keep firing on account-wide activity that has nothing
to do with this project. In November 2026 the
`learning-lab-platform-unauthorized-api-calls` alarm fired every hour on
`AccessDenied` calls from AWS Config's service-linked role, weeks after dev
was gone. Destroy this root after dev when the project is being removed from
the account. It was last destroyed on 2026-11-23.

The steps assume an administrator identity and a root that is initialised
against a backend that still exists (`init` as in [Usage](#usage), with the
ignored `terraform.tfvars` in place).

1. Check who else trusts the GitHub OIDC provider. IAM allows one provider
   per URL, so roles of other repositories in this account may use it:

   ```sh
   AWS_PROFILE=default aws iam list-roles --query "Roles[?contains(to_string(AssumeRolePolicyDocument), 'token.actions.githubusercontent.com')].RoleName"
   ```

   If any role outside this project is listed, keep the provider and only
   stop managing it:

   ```sh
   AWS_PROFILE=default terraform -chdir=infra/aws/account-security state rm aws_iam_openid_connect_provider.github_actions
   ```

   Do this on every teardown, also after the provider was imported again
   ([Usage](#usage)): a destroy with the provider in state deletes it for
   everyone.

2. Decide what happens to the CloudTrail log archive; the next steps delete
   it for good. To keep it, copy the bucket out first, or `state rm` every
   `aws_s3_bucket*.cloudtrail` resource and `aws_kms_key.cloudtrail` so they
   stay behind and the 365-day lifecycle rule expires the logs (then leave
   the bucket out of step 3). Account activity is still recorded either way
   by the pre-existing `rumo-claims-trail` and by the 90-day CloudTrail event
   history.

3. In a working copy only (do not commit this), set every
   `prevent_destroy = true` in `main.tf` to `false` and add
   `force_destroy = true` to `aws_s3_bucket.cloudtrail`, then record the
   bucket change in state so the destroy may empty the versioned bucket:

   ```sh
   AWS_PROFILE=default terraform -chdir=infra/aws/account-security apply -target=aws_s3_bucket.cloudtrail
   ```

4. Destroy, then restore `main.tf`:

   ```sh
   AWS_PROFILE=default terraform -chdir=infra/aws/account-security destroy
   git checkout -- infra/aws/account-security/main.tf
   ```

   Emptying the trail bucket is almost all of the run (about 20 minutes on
   2026-11-23). If the bucket delete times out or fails with
   `BucketNotEmpty` because a late log delivery landed, run the destroy
   again; that is safe. The CloudWatch log group goes too, and the two KMS
   keys are scheduled for deletion after 30 days. Expect a last few
   notifications from the alert pipeline about its own removal.
