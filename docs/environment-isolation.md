# Hosted environment isolation

Production must not share an AWS account, Clerk application, or Convex
deployment with staging. The machine-readable registry at
[`config/hosted-environments.json`](../config/hosted-environments.json) is the
repository inventory used by the hosted deployment guards. The external AWS,
Clerk, and Convex control planes remain authoritative for resources that
actually exist.

## Current status

| Boundary | Development | Staging | Production | Status |
| --- | --- | --- | --- | --- |
| AWS account | Local or operator-selected | `442359104502` | `442359104502` | Temporary exception |
| Clerk application | Current development application | Not provisioned | Not provisioned | Blocked |
| Convex deployment | Current local development deployment | Not provisioned | Not provisioned | Blocked |

The approved AWS exception authorizes staging and production foundation
deployment in the shared account. Production learner traffic remains
procedurally blocked while any production-readiness blocker remains. The
existing Clerk application and Convex deployment are development-only and must
not be promoted by changing their labels or environment variables.

## Temporary exception

The repository owner approved temporary AWS account sharing for staging and
production. The exception permits only the `awsAccountId` identity to be shared.
It does not permit shared Clerk applications or Convex deployments and does not
allow production learner traffic.

- Deadline: 2026-08-12
- Earlier cutoff: before any production learner traffic
- Owner: platform owner
- Approver: repository owner
- Migration status: in progress
- Production learner traffic: procedurally blocked

If the deadline passes, the registry validation fails until the missing
resources are provisioned. Extending the deadline requires a reviewed commit
that records the reason, approver, replacement deadline, and migration status.

## Provisioning and migration sequence

1. Create or designate a staging AWS account outside the production account.
2. Bootstrap the staging Terraform backend in that account and record its
   twelve-digit account ID in the registry and staging Terraform examples.
3. Create dedicated staging and production Clerk applications. Configure each
   with only its environment's origins, redirect URLs, webhook destinations,
   and Convex JWT template. Record the non-secret application IDs.
4. Create dedicated staging and production Convex deployments. Configure each
   to trust only its matching Clerk issuer and record the deployment names.
5. Store each environment's secret values only in its deployment system and
   AWS Secrets Manager. Do not commit publishable keys, secret keys, deployment
   URLs, deploy keys, or webhook secrets to this registry.
6. Use the guarded Terraform commands while the AWS exception is active. Run
   `npm run env:isolation:require-ready` before deploying hosted Convex
   functions or enabling production learner traffic.
7. Deploy and qualify staging first. Promote the same reviewed source and
   immutable artifacts to production without copying staging data or secrets.

## Automated checks

`npm run env:isolation:check` validates the registry structure and reports
current blockers without failing before the deadline. Use the guarded commands
for hosted changes:

```sh
npm run infra:staging:plan -- -- -var-file=staging.tfvars
npm run infra:staging:apply -- -- -var-file=staging.tfvars
npm run infra:production:plan -- -- -var-file=production.tfvars
npm run infra:production:apply -- -- -var-file=production.tfvars
CONVEX_DEPLOYMENT=<registered-name> npm run convex:staging:deploy
CONVEX_DEPLOYMENT=<registered-name> npm run convex:production:deploy
```

The guards fail for missing, malformed, or unauthorized shared identities.
Terraform permits only the approved staging and production AWS account pair
before its deadline. It also checks the active AWS account through the AWS CLI,
passes the registered account to Terraform, and has an in-configuration
precondition so direct plan or apply fails when the AWS identity is incomplete
or inconsistent. The Convex guard checks
the selected `CONVEX_DEPLOYMENT` name. It cannot prove that the deploy key or
remote deployment belongs to that name, so operators must still verify Convex
credentials in the dashboard. Clerk has no deployment command here; its actual
application settings must likewise be verified in the Clerk dashboard.

Direct Terraform and Convex CLI invocations can bypass repository wrapper
scripts. CI and operator procedures must use the guarded commands. Local Vite,
Convex development, and local runner commands remain unchanged.

The registry's `productionLearnerTrafficBlocked` field records the required
operator procedure. It is not an AWS traffic kill switch. During the approved
AWS account-sharing exception, staging uses a distinct
state key in the production state bucket and distinct environment-prefixed
resources. Moving staging to its own account and backend remains mandatory by
the exception deadline.
