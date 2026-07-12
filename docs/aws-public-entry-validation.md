# AWS public entry validation

Validated on 2026-07-12 in AWS account `442359104502`, region `us-east-2`,
using the default AWS profile.

## Deployed hostnames

| Environment | Base hostname | Workspace hostname |
| --- | --- | --- |
| Staging | `staging.learning-lab-platform.rumothy.com` | `*.staging.learning-lab-platform.rumothy.com` |
| Production | `learning-lab-platform.rumothy.com` | `*.learning-lab-platform.rumothy.com` |

Both environments use DNS-validated ACM certificates issued in `us-east-2`.
Route 53 A aliases send the base and wildcard hostnames to their environment's
internet-facing ALB. IPv6 aliases are intentionally omitted because the VPC
and subnets currently use IPv4 only.

## Qualification evidence

- Terraform validation passed for staging and production.
- Each deployment plan added only the public entry resources and destroyed no
  resources.
- Staging was deployed and qualified before production.
- The staging post-deployment plan reported no changes.
- HTTPS requests to both base hostnames returned HTTP 503 with the correct
  environment and `gateway-deployment-pending` status.
- A production wildcard hostname returned the same production status.
- Production HTTP returned 301 and redirected to HTTPS.

The status response is deliberate. This task establishes public DNS, TLS, and
the ALB boundary only. It does not expose a learner session or claim that the
application gateway has been deployed. A later launch task will replace the
fixed response with authenticated gateway routing.
