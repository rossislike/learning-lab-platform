# Hosted environment isolation

Staging and production intentionally run in one AWS account. They must use
separate Terraform state, resource names, networks, IAM roles, KMS keys, ECR
repositories, S3 buckets, Secrets Manager secrets, Clerk applications, and
Convex deployments. The machine-readable registry at
[`config/hosted-environments.json`](../config/hosted-environments.json) is the
inventory used by deployment guards. The external control planes remain
authoritative for resources that actually exist.

## Current status

| Boundary | Development | Staging | Production | Status |
| --- | --- | --- | --- | --- |
| AWS account | Local or operator-selected | `442359104502` | `442359104502` | Configured shared account |
| Terraform state | Local | `learning-lab-platform/staging/terraform.tfstate` | `learning-lab-platform/production/terraform.tfstate` | Isolated |
| AWS resources | Local | `staging` scoped | `production` scoped | Isolated |
| Clerk application | Current development application | Registered as `app_3HxfK5v1psg7C6v2buk86Y5ctro` | Not provisioned | Production provisioning blocked |
| Convex deployment | Current local selection `dev:trustworthy-robin-688` | Permanent non-default prod-type deployment `prod:upbeat-crab-254` | Default prod-type deployment `prod:aware-fish-663` | Provisioned and registered; auth configuration and code deployment pending |

AWS account sharing is the permanent topology, not an exception. Production
learner traffic remains procedurally blocked because the production Clerk
application is missing and hosted auth configuration and Convex code deployment
are incomplete. The development Clerk application and
`dev:trustworthy-robin-688` selection remain development-only and must not be
promoted by changing labels or environment variables.

## Shared-account boundaries

The following boundaries are mandatory for both hosted environments:

1. Use the `default` AWS CLI profile and verify account `442359104502` before
   every plan, apply, publication, or promotion.
2. Initialize each Terraform root with its own backend file and state key.
   Never migrate or copy state between staging and production.
3. Keep environment-specific VPCs, subnets, security groups, ECS resources,
   IAM roles, KMS keys, ECR repositories, S3 buckets, secrets, and logs.
4. Keep staging and production Clerk applications and Convex deployments
   distinct. AWS account sharing does not authorize sharing application
   identities, credentials, data, or deployment configuration.
5. Qualify changes in staging first, then promote reviewed source and immutable
   artifacts to production. Do not copy staging secrets or learner data.

The account-level Terraform root owns resources that AWS permits only once per
account, including the GitHub Actions OIDC provider and shared security alert
pipeline. Apply it before either environment root.

## Remaining configuration and deployment sequence

1. Create the dedicated production Clerk application and record its non-secret
   application ID. The staging Clerk application and both hosted Convex
   deployments are already provisioned and registered; do not recreate them.
2. Configure each hosted Clerk application with only its environment's origins,
   redirect URLs, webhook destinations, and Convex JWT template. Configure
   `prod:upbeat-crab-254` and `prod:aware-fish-663` to trust only their matching
   staging and production Clerk issuers, respectively.
3. Store each environment's secret values only in its deployment system and
   AWS Secrets Manager. Do not commit publishable keys, secret keys, deployment
   URLs, deploy keys, or webhook secrets to the registry.
4. Run `npm run env:isolation:require-ready` before hosted Convex deployment,
   image publication, or production learner traffic. This guard remains blocked
   until the production Clerk application ID is registered.
5. Deploy the reviewed Convex schema and functions to staging and qualify the
   matching Clerk issuer configuration. Then promote the same reviewed source
   and immutable artifacts to production and qualify its issuer configuration.

## Automated checks

`npm run env:isolation:check` validates the registry and reports current
blockers. Use the guarded commands for hosted changes:

```sh
AWS_PROFILE=default npm run infra:staging:plan -- -- -var-file=staging.tfvars
AWS_PROFILE=default npm run infra:staging:apply -- -- -var-file=staging.tfvars
AWS_PROFILE=default npm run infra:production:plan -- -- -var-file=production.tfvars
AWS_PROFILE=default npm run infra:production:apply -- -- -var-file=production.tfvars
CONVEX_DEPLOYMENT=<registered-name> npm run convex:staging:deploy
CONVEX_DEPLOYMENT=<registered-name> npm run convex:production:deploy
```

The guards require both hosted AWS identities to match the configured shared
account and continue rejecting shared Clerk or Convex identities. Terraform
checks the active AWS account, receives the registered account as an input, and
has an in-configuration precondition so a direct plan or apply fails when the
account topology is inconsistent. The Convex guard checks the selected
`CONVEX_DEPLOYMENT` name. Operators must still verify the actual remote Convex
and Clerk settings in their dashboards.

Direct Terraform and Convex CLI invocations can bypass repository wrapper
scripts. CI and operator procedures must use the guarded commands. Local Vite,
Convex development, and local runner commands remain unchanged.

`productionLearnerTrafficBlocked` is an operator release gate, not an AWS
traffic kill switch. It must remain `true` while any hosted identity is missing
and through the pending auth configuration, code deployment, and production
release gates. Identity readiness is necessary but not sufficient to enable
production learner traffic.
