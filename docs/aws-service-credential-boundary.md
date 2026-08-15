# AWS service credential boundary

Staging and production each own an independent Secrets Manager secret named
`learning-lab-platform-<environment>/dispatcher/runner-shared-secret`. The
secret is encrypted with an environment-specific, rotation-enabled KMS key.
Terraform owns the secret metadata, KMS key, and IAM policies, but it never
owns a secret version or value. This keeps plaintext out of Terraform state,
plans, and repository files.

The boundary uses two dispatcher roles:

- The dispatcher execution role can retrieve only the environment's shared
  runner secret and decrypt it only through that environment's Secrets Manager
  service with the matching secret ARN encryption context. Explicit deny
  statements in the secret resource policy and KMS key policy prevent other
  account principals, including administrators, from retrieving or decrypting
  the value. Key administration and write-only secret seeding and rotation
  remain available to authorized operators.
- The dispatcher task role can start learner tasks from only the environment's
  task family and cluster, and every launch must include
  `learning-lab:managed=true`. The role can apply only the approved task tags
  during `RunTask`, and it can describe or stop only tasks that retain the
  managed tag. It can pass only the learner task execution role and, when the
  learner metadata boundary is disabled, the learner task role. It cannot
  retrieve or decrypt service secrets.

The learner task execution role remains limited to image pulls and log
delivery. Boundary-enabled learner tasks have no task role, and their task
definition has no service-secret injection. A future dispatcher task
definition may inject the shared secret from Secrets Manager during startup
through the dedicated dispatcher execution role. It must never copy that
reusable credential into a learner task override.

The existing `runner/aws-ecs-fargate-runner.mjs` adapter is a local prototype
that still constructs a learner override containing `RUNNER_SHARED_SECRET`.
It is not deployed by this Terraform module and must not be used with staging
or production. The Phase 3 session-bound callback roadmap task remains open
until that override is removed and the short-lived protocol replaces it.

## Initial value and rotation

After Terraform creates the secret metadata, create a high-entropy value
without printing it or putting it in shell history:

```sh
aws secretsmanager get-random-password \
  --region us-east-2 \
  --password-length 64 \
  --exclude-punctuation \
  --query RandomPassword \
  --output text \
  | tr -d '\r\n' \
  | aws secretsmanager put-secret-value \
      --region us-east-2 \
      --secret-id '<terraform dispatcher_runner_shared_secret_arn output>' \
      --secret-string file:///dev/stdin \
      --output json >/dev/null
```

Verify only metadata, never the value:

```sh
aws secretsmanager describe-secret \
  --region us-east-2 \
  --secret-id '<terraform dispatcher_runner_shared_secret_arn output>' \
  --query '{ARN:ARN,KmsKeyId:KmsKeyId,VersionIdsToStages:VersionIdsToStages}'
```

When the matching Convex deployment and dispatcher service are provisioned,
rotate this value as one coordinated change. Store the same value in the
matching Convex environment, create the new Secrets Manager version, restart
the dispatcher, verify callbacks, and then remove any superseded Convex value.
Never retrieve or print the AWS value for validation.

## Human operator access

Do not store human AWS access keys in Secrets Manager. The active operator
workflow for account `442359104502` currently uses the AWS CLI `default`
profile as IAM user `devAdmin`. This identity was verified on 2026-08-15 with
`aws sts get-caller-identity`.

Before every hosted operation, verify the profile and account:

```sh
AWS_PROFILE=default aws sts get-caller-identity
```

Do not create additional environment-specific AWS profiles or credentials.
Staging and production use this same account identity and rely on Terraform
state and resource boundaries for isolation.

IAM Identity Center remains the preferred long-term human access mechanism
because it issues short-lived credentials. The account also has these one-hour
assignments:

- `prodAdmin` has `PowerUserAccess` for routine application operations.
- `awsAdmin` has `AdministratorAccess` for IAM, recovery, and other privileged
  account operations.

Both assignments were verified on 2026-07-18. They can be started with:

```sh
aws sso login --profile learning-lab-prod
aws sso login --profile learning-lab-admin
```

The `default` profile now has active `devAdmin` credentials. Keep them outside
the repository, do not print them, and rotate or replace them with federation
through a separately reviewed credential change.

## Deployment evidence

The staging boundary was applied first on 2026-07-18. Its Terraform plan added
seven resources and changed or destroyed none. The production promotion used
the same reviewed shape and also added seven resources with no changes or
destruction. Each environment now has:

- one protected Secrets Manager secret with exactly one `AWSCURRENT` version;
- one independent, rotation-enabled KMS key;
- one dispatcher execution role scoped to the exact secret and key; and
- one dispatcher task role scoped to the environment learner task family and
  managed tasks in its cluster, with no Secrets Manager or KMS decryption
  action.

Live validation retrieved each secret through KMS while discarding all command
output, inspected only version metadata, and confirmed the learner execution
roles still have only their existing `runner-image-and-logs` policy. No secret
value was printed, committed, or placed in Terraform state.
