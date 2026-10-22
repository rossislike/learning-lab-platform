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
  (`modules/github-image-delivery`, Phase 6) trust
- deployment checks: the active account must match
  `expected_aws_account_id`, and the pre-existing GuardDuty detector must be
  enabled with Runtime Monitoring and its ECS Fargate agent management
  configuration turned on. The ECS Fargate check is a leftover from the
  retired ECS plan (revisit for EKS in Phase 5).

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
It is currently `false`. Once `dev` is deployed (Phase 5), toggle it to `true`
by hand, commit the change, and apply this root to create the twelve alarms.
Because the alarms have `prevent_destroy = true`, flipping it back to `false`
requires removing that lifecycle guard first.
