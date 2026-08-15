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
This exact identity is the only sharing exception. Production uses the distinct
application `app_3HxpakMJmYEYqRjofDF3wrByUqx`, production instance
`ins_3Hxpwld1IGCSIDBX7vZ3qqzLkTq`, and issuer
`https://clerk.learning-lab-platform.rumothy.com`.

## Current status

| Boundary | Development | Staging | Production | Status |
| --- | --- | --- | --- | --- |
| AWS account | Local or operator-selected | `442359104502` | `442359104502` | Configured shared account |
| Terraform state | Local | `learning-lab-platform/staging/terraform.tfstate` | `learning-lab-platform/production/terraform.tfstate` | Isolated |
| AWS resources | Local | `staging` scoped | `production` scoped | Isolated |
| Clerk identity | `app_3GKhzAioaTZbOK6QwVEL8qxIHS3` / `ins_3GKhzB4WHOIij3p0UthvLWPmVCG` | Same verified development identity and issuer | `app_3HxpakMJmYEYqRjofDF3wrByUqx` / `ins_3Hxpwld1IGCSIDBX7vZ3qqzLkTq` | Development and staging intentionally shared; production isolated |
| Convex deployment | Current local selection `dev:trustworthy-robin-688` | Permanent non-default prod-type deployment `prod:upbeat-crab-254` | Default prod-type deployment `prod:aware-fish-663` | Provisioned and registered; matching Clerk issuers configured; code deployment pending |

AWS account sharing is the permanent topology, not an exception. Clerk
production-domain verification, both `convex` JWT templates, and both matching
Convex issuer values were remotely verified on 2026-08-15. Production learner
traffic remains procedurally blocked because hosted origins, redirects, keys,
webhooks, Convex code deployment, and the remaining release gates are
incomplete. Development and staging must use only the declared Clerk
development instance and issuer, and `dev:trustworthy-robin-688` remains a
development-only Convex selection. None may be promoted to production by
changing labels or environment variables.

The shared Clerk development instance has a more relaxed security posture and
a 100-user limit. Staging must remain internal and low-volume while it uses this
instance. Revisit this exception and create a dedicated Clerk staging
application before staging becomes an external or production-like workload.

## Verified hosted authentication contract

Authenticated remote reads on 2026-08-15 verified that both the shared
development-staging Clerk instance and the isolated production Clerk instance
have a JWT template named `convex` with this exact claim body:

```json
{
  "aud": "convex",
  "name": "{{user.first_name}}",
  "email": "{{user.primary_email_address}}",
  "picture": "{{user.image_url}}"
}
```

Both templates use `RS256`, a 60-second token lifetime, a 5-second allowed
clock skew, and Clerk-managed signing keys with custom signing keys disabled.
The Clerk production-domain check also showed all five required DNS records as
verified.

Authenticated remote Convex reads on the same date verified these exact
deployment environment values:

| Environment | Convex deployment | Environment value |
| --- | --- | --- |
| Staging | `prod:upbeat-crab-254` | `CLERK_JWT_ISSUER_DOMAIN=https://amazed-adder-35.clerk.accounts.dev` |
| Production | `prod:aware-fish-663` | `CLERK_JWT_ISSUER_DOMAIN=https://clerk.learning-lab-platform.rumothy.com` |

These remote settings establish the token contract and issuer mapping. They do
not prove that the pending frontend settings, deployed Convex code, or complete
sign-in flow work end to end.

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

1. Configure the shared Clerk development instance with the required local and
   staging origins, redirect URLs, and staging webhook destinations. Configure
   the production Clerk application independently with its production origins,
   redirects, keys, account-management URLs, and webhook destinations. The
   production domain, both exact `convex` JWT templates, and both matching
   Convex issuer values were remotely verified on 2026-08-15 as recorded above.
2. Store each environment's secret values only in its deployment system and
   AWS Secrets Manager. Do not commit publishable keys, secret keys, deployment
   URLs, deploy keys, or webhook secrets to the registry. Store distinct
   deployment-scoped Convex deploy keys for staging and production. Inject them
   only for the guarded command and do not place them in shell history, `.env`,
   `.env.local`, command arguments, logs, or repository files.
3. Run `npm run env:isolation:require-ready` before hosted Convex deployment,
   image publication, or production learner traffic. Identity readiness does
   not replace remote Clerk, Convex issuer, or application-origin verification.
4. Deploy the reviewed Convex schema and functions to staging and qualify Clerk
   sign-in plus Convex token validation end to end. Then promote the same
   reviewed source and immutable artifacts to production and repeat that
   qualification before any production learner traffic is enabled.

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
