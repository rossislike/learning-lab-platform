# AWS account security

This Terraform root owns account-wide security controls that must not be duplicated by the staging and production environment states:

- a dedicated multi-region CloudTrail for all management events
- log file validation, KMS encryption, protected S3 retention, and CloudWatch delivery
- CloudTrail metric filters and alarms for high-risk account changes
- a shared encrypted SNS security alert topic
- an independent EventBridge route for security alert pipeline mutations
- routing for GuardDuty findings with severity 4 or higher
- deployment checks that require GuardDuty Runtime Monitoring and ECS Fargate agent management
- the single account-level GitHub Actions OIDC provider used by environment-specific delivery roles

The pre-existing `rumo-claims-trail` remains independently owned because it captures a separate S3 data-event use case. This root does not manage the existing GuardDuty detector. It validates the detector and routes findings without taking over its lifecycle.

Copy `account-security.s3.tfbackend.example` to the ignored `account-security.s3.tfbackend`, and copy `terraform.tfvars.example` to the ignored `terraform.tfvars`. Replace example values before applying.

```sh
AWS_PROFILE=default terraform -chdir=infra/aws/account-security init -backend-config=account-security.s3.tfbackend
AWS_PROFILE=default terraform -chdir=infra/aws/account-security plan
AWS_PROFILE=default terraform -chdir=infra/aws/account-security apply
```

`security_alert_email` is required so an apply cannot silently omit the notification recipient or delete the confirmed subscription. AWS sends a confirmation message when the endpoint changes. Notifications do not reach the new address until the recipient confirms that subscription. Terraform can verify that the subscription is configured, but operators must inspect SNS or perform a delivery test to verify confirmation.

Deploy this root before the staging or production roots. Each environment resolves the topic and GitHub Actions OIDC provider so planning fails safely when shared account resources do not exist. The topic and both encryption keys use Terraform deletion protection. To recover an environment after an account-security interruption, restore or apply this root first, confirm the subscription, and only then apply the environment root.

Staging and production permanently share one AWS account. Instantiate this root exactly once in account `442359104502`; do not duplicate its resources in either environment state.
