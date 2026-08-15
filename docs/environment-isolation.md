# Hosted environment isolation

Staging and production intentionally run in one AWS account. They must use
separate Terraform state, resource names, networks, IAM roles, KMS keys, ECR
repositories, S3 buckets, Secrets Manager secrets, Clerk applications, and
Convex deployments. The machine-readable registry at
[`config/hosted-environments.json`](../config/hosted-environments.json) is the
schema version 3 inventory used by the JavaScript and Terraform deployment
guards. Every consumer must require the same schema version. The external
control planes remain authoritative for resources that actually exist.

Development and staging intentionally share the host-verified development
instance `ins_3GKhzB4WHOIij3p0UthvLWPmVCG` in Clerk application
`app_3GKhzAioaTZbOK6QwVEL8qxIHS3`. Its issuer is
`https://amazed-adder-35.clerk.accounts.dev`, derived from the verified
development publishable key and matching Clerk's development issuer format.
This exact identity is the only sharing exception.

The same Clerk application has an activated production instance. That instance
is intentionally not selected or registered for production in this repository.
Production Clerk remains isolated and wholly unconfigured in the environment
registry. The separately created staging-only application
`app_3HxfK5v1psg7C6v2buk86Y5ctro` is also intentionally not selected. Preserve
it as-is: this change does not authorize deleting it or modifying it remotely.

## Current status

| Boundary | Development | Staging | Production | Status |
| --- | --- | --- | --- | --- |
| AWS account | Local or operator-selected | `442359104502` | `442359104502` | Configured shared account |
| Terraform state | Local | `learning-lab-platform/staging/terraform.tfstate` | `learning-lab-platform/production/terraform.tfstate` | Isolated |
| AWS resources | Local | `staging` scoped | `production` scoped | Isolated |
| Clerk identity | `app_3GKhzAioaTZbOK6QwVEL8qxIHS3` / `ins_3GKhzB4WHOIij3p0UthvLWPmVCG` | Same verified development identity and issuer | Unconfigured; activated production instance not registered | Development and staging intentionally shared; production registration blocked |
| Convex deployment | Current local selection `dev:trustworthy-robin-688` | Permanent non-default prod-type deployment `prod:upbeat-crab-254` | Default prod-type deployment `prod:aware-fish-663` | Provisioned and registered; auth configuration and code deployment pending |

AWS account sharing is the permanent topology, not an exception. Production
learner traffic remains procedurally blocked because a production Clerk identity
has not been registered and hosted auth configuration and Convex code deployment
are incomplete. Development and staging must use only the declared Clerk
development instance and issuer, and `dev:trustworthy-robin-688` remains a
development-only Convex selection. None may be promoted to production by
changing labels or environment variables.

The shared Clerk development instance has a more relaxed security posture and
a 100-user limit. Staging must remain internal and low-volume while it uses this
instance. Revisit this exception and create a dedicated Clerk staging
application before staging becomes an external or production-like workload.

## Shared-account boundaries

The following boundaries are mandatory for both hosted environments:

1. Use the `default` AWS CLI profile and verify account `442359104502` before
   every plan, apply, publication, or promotion.
2. Initialize each Terraform root with its own backend file and state key.
   Never migrate or copy state between staging and production.
3. Keep environment-specific VPCs, subnets, security groups, ECS resources,
   IAM roles, KMS keys, ECR repositories, S3 buckets, secrets, and logs.
4. Keep staging and production Clerk applications and Convex deployments
   distinct. The declared development-staging Clerk exception does not
   authorize any production sharing of identities, credentials, data, or
   deployment configuration.
5. Qualify changes in staging first, then promote reviewed source and immutable
   artifacts to production. Do not copy staging secrets or learner data.

The account-level Terraform root owns resources that AWS permits only once per
account, including the GitHub Actions OIDC provider and shared security alert
pipeline. Apply it before either environment root.

## Remaining configuration and deployment sequence

1. Create or designate a dedicated, isolated production Clerk application and
   record its complete non-secret identity only after that production topology
   is approved. Do not register the activated production instance from
   `app_3GKhzAioaTZbOK6QwVEL8qxIHS3` as a shortcut. The shared
   development-staging Clerk development instance and both hosted Convex
   deployments are already provisioned and registered; do not recreate them.
   Preserve `app_3HxfK5v1psg7C6v2buk86Y5ctro` without remote changes.
2. Configure the shared Clerk development instance with the required local and
   staging origins, redirect URLs, staging webhook destinations, and Convex JWT
   template. Configure the production Clerk application independently.
   Configure `prod:upbeat-crab-254` and `prod:aware-fish-663` to trust only their
   matching staging and production Clerk issuers, respectively.
3. Store each environment's secret values only in its deployment system and
   AWS Secrets Manager. Do not commit publishable keys, secret keys, deployment
   URLs, deploy keys, or webhook secrets to the registry. Store distinct
   deployment-scoped Convex deploy keys for staging and production. Inject them
   only for the guarded command and do not place them in shell history, `.env`,
   `.env.local`, command arguments, logs, or repository files.
4. Run `npm run env:isolation:require-ready` before hosted Convex deployment,
   image publication, or production learner traffic. This guard remains blocked
   until the complete production Clerk identity is registered.
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
CONVEX_DEPLOY_KEY="$STAGING_CONVEX_DEPLOY_KEY" npm run convex:staging:deploy
CONVEX_DEPLOY_KEY="$PRODUCTION_CONVEX_DEPLOY_KEY" npm run convex:production:deploy
```

The guards require both hosted AWS identities to match the configured shared
account. They allow only the exact verified development-staging Clerk identity
and continue rejecting any production Clerk sharing or shared Convex identities.
Terraform checks the active AWS account, receives the registered account as an
input, and has an in-configuration precondition so a direct plan or apply fails
when the account topology is inconsistent. The Convex guard requires a
deployment-scoped `CONVEX_DEPLOY_KEY` whose non-secret prefix matches the
registered environment deployment. It rejects the deploy-key alias, ambient
`CONVEX_DEPLOYMENT`, self-hosted selectors, env files, preview flags, and other
target flags. It preserves only the validated deploy key while clearing every
conflicting selector in the child environment. Before deploying, it uses that
same key to read `CLERK_JWT_ISSUER_DOMAIN` and requires the result to equal the
environment's registered issuer. The guard never prints the key or the returned
issuer value on failure.

Direct Terraform and Convex CLI invocations remain a residual bypass risk: they
can avoid the repository wrapper's target validation, sanitized environment, and
remote issuer preflight. CI and operator procedures must use the guarded
commands. The wrapper does not prove Clerk dashboard configuration beyond the
registered issuer. Local Vite, Convex development, and local runner commands
remain unchanged.

`productionLearnerTrafficBlocked` is an operator release gate, not an AWS
traffic kill switch. It must remain `true` while any hosted identity is missing
and through the pending auth configuration, code deployment, and production
release gates. Identity readiness is necessary but not sufficient to enable
production learner traffic.
