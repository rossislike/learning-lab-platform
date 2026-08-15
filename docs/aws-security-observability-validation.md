# AWS security observability validation

Validated on 2026-07-18 in AWS account `442359104502`, region `us-east-2`.

## Ownership boundaries

The `infra/aws/account-security` Terraform root owns account-wide controls. It does not take ownership of the pre-existing `rumo-claims-trail`, which remains dedicated to its separate S3 data-event use case. It also does not manage the lifecycle of the existing GuardDuty detector. Deployment checks require that detector, Runtime Monitoring, and ECS Fargate agent management to remain enabled.

The staging and production roots own their environment WAF, WAF logs, ALB access log bucket, ALB logging configuration, and environment alarms. The shared account root owns the encrypted SNS destination used by those alarms.

Staging and production permanently share one AWS account. Apply `infra/aws/account-security` once in that account. Both environment roots resolve the shared alert topic and GitHub Actions OIDC provider while retaining environment-specific IAM roles and resources.

## Account controls

The new `learning-lab-platform-management-events` trail is enabled, multi-region, includes global service events, records all read and write management events, validates log files, and delivers to both its protected S3 bucket and CloudWatch Logs. Live status reported recent successful S3 and CloudWatch deliveries with no delivery error.

The CloudTrail S3 bucket uses a customer-managed KMS key with rotation, versioning, public access blocks, TLS enforcement, lifecycle retention, and Terraform deletion protection. Current and noncurrent log object versions have the same 365-day retention. CloudTrail configuration changes, root use, unauthorized calls, console login without MFA, IAM changes, KMS disable or deletion, and security group changes have metric filters and alarms. A separate EventBridge route sends CloudTrail API events for CloudWatch alarm and metric filter changes, SNS changes, EventBridge rule and target changes, WAF association and logging changes, and ALB logging changes directly to the security topic. This route does not depend on the metric filters or alarms that it monitors.

The existing GuardDuty detector reported `ENABLED`. Its `RUNTIME_MONITORING` feature and `ECS_FARGATE_AGENT_MANAGEMENT` additional configuration both reported `ENABLED`. GuardDuty findings with severity 4 or higher route through EventBridge to the encrypted security topic. End-to-end qualification generated severity-8 sample finding `815fe07f0bc14e2dbc4b779587afd9ef` with type `Backdoor:EC2/DenialOfService.Tcp` at 2026-07-18 19:46:46 UTC. The `learning-lab-platform-guardduty-findings` rule recorded one invocation at 19:49 UTC, SNS recorded one delivered notification and zero failures at 19:50 UTC, and the recipient confirmed email receipt on 2026-07-19. This completed qualification of the independent GuardDuty-to-EventBridge-to-SNS path.

A reversible staging alarm-state test entered `ALARM`, successfully executed the encrypted SNS publish action, and then restored the alarm to `OK`. CloudWatch alarm history recorded the action state as `Succeeded` at 2026-07-18 18:05 UTC. The confirmed recipient reported receiving the resulting alarm email, completing the end-to-end notification qualification.

No email endpoint is stored in the repository. Operators must set the required `security_alert_email` in the ignored account-security variables file. AWS requires the recipient to confirm that subscription before email delivery begins. The deployed subscription was confirmed and its end-to-end alarm receipt was verified before this roadmap item was completed. Terraform reports only that the subscription is configured because SNS confirmation state is not exposed by this resource.

## Staging qualification

Staging was deployed and tested before production promotion.

- A normal request returned `503`, preserving the existing gateway placeholder behavior.
- An encoded XSS probe returned `403`, confirming WAF enforcement through the public endpoint.
- The ALB reported access logging enabled with prefix `alb`.
- The protected access log bucket contained `ELBAccessLogTestFile` at the expected account-scoped path.
- Delivered access log objects require an account and region scoped `aws:SourceArn`. Because the live ELB validation request omits that key, a separate policy statement permits only the documented `ELBAccessLogTestFile` object.
- The WAF uses the AWS IP reputation, known bad inputs, and common protection managed groups plus a per-IP rate limit.
- WAF logs redact authorization, cookie, common credential headers, and the complete query string.
- WAF request sampling is disabled because sampled requests do not honor WAF logging redaction.
- ALB access logs retain request URLs and cannot redact individual URL fields. Credentials, bearer tokens, bootstrap codes, signed URLs, and other secrets must never be placed in URLs or query parameters.

## Production qualification

- A normal request returned `503`, preserving the existing gateway placeholder behavior.
- The same XSS probe returned `403`.
- The production ALB reported access logging enabled with prefix `alb`.
- The production bucket contained both `ELBAccessLogTestFile` and a delivered compressed ALB request log.
- Current and noncurrent ALB log object versions use the environment retention period: 90 days in staging and 365 days in production.
- The production ALB had the four-rule WAF associated.
- The production WAF, rejected connection, and TTL cleanup alarms all reported `OK` and used the encrypted shared SNS topic as their alarm action.

The current public listeners intentionally return the fixed `503` gateway placeholder and do not expose sign-in, authenticated, upload, or application API routes. Those flows could not be qualified in this deployment. Before the hosted application replaces the placeholder response, staging must exercise sign-in, an authenticated session, uploads, and representative API calls through WAF. Production promotion must remain blocked if any legitimate flow is rejected.

## Drift and verification

After live qualification, all three roots were refreshed again. Account security, staging, and production each reported `0 to add, 0 to change, 0 to destroy`.

Local verification included Terraform formatting and validation, the full repository test suite, lint, build, and the focused security observability contract tests.
