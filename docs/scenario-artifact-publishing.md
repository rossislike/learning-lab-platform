# Scenario artifact publishing

Hosted scenarios use immutable, content-addressed objects in each environment's
artifact bucket. A hosted session request is rejected unless Convex contains an
active approval for the exact scenario, environment, artifact digest, and
publication manifest digest.

Local sessions continue to use repository workspace templates and do not need
artifact approvals.

## Artifact contract

The publisher creates two deterministic objects for each active scenario:

- `scenarios/<slug>/artifacts/sha256/<digest>.tar` contains only the starter
  workspace. It excludes the author manifest and solution workspace.
- `scenarios/<slug>/manifests/sha256/<digest>.json` contains the runtime commands,
  expected ports, bounded artifact size, artifact key, and artifact digest.

Both objects carry an S3 SHA-256 checksum plus `sha256` and `immutable` metadata.
Uploads use `If-None-Match: *` and bind every S3 request to the configured AWS
account with `--expected-bucket-owner`. The artifact bucket policy denies
scenario writes that do not use that create-only precondition. It also denies
scenario object deletion and version deletion, preventing delete markers or
version removal from making an approved key reusable. Only the guarded
environment teardown workflow temporarily removes the deletion deny.

The publisher rejects symbolic links including a symlinked workspace root,
non-file entries, paths outside the starter workspace, workspace and solution
overlap, non-active scenarios, more than 10,000 archive entries, source
manifests larger than 1 MiB, artifacts larger than 64 MiB, and paths that exceed
the portable tar format limit. File sizes and cumulative tar size are checked
before file contents are read.

## Deployment prerequisites

Before publishing, complete all of the following for the target environment:

1. Configure its AWS account and Convex deployment in
   `config/hosted-environments.json`.
2. Deploy the current Convex schema and functions.
3. Set `HOSTED_ENVIRONMENT` to exactly `staging` or `production` in that Convex
   deployment.
4. Apply the current Terraform so the artifact bucket policy is active.
5. Use a temporary operator session for the configured AWS account with
   permission to read Terraform outputs, `s3:PutObject` and `s3:GetObject` for
   scenario objects, and `kms:Decrypt` and `kms:GenerateDataKey` on the
   environment data key. The get and KMS permissions are required when
   checksum-enabled `HeadObject` verifies an SSE-KMS object.

The Convex approval function is internal. The publisher invokes it through the
deployment-authenticated Convex CLI only after S3 returns matching object size,
checksum, and metadata for both objects.

## Validate locally

Build every active scenario deterministically without contacting AWS or Convex:

```bash
npm run scenarios:publish -- staging --dry-run
```

Limit validation or publication to one or more scenarios with repeated slug
arguments:

```bash
npm run scenarios:publish -- staging \
  --slug=react-welcome-message \
  --slug=react-button-label \
  --dry-run
```

## Publish and approve

Publish to staging first:

```bash
npm run scenarios:publish -- staging
```

After staging qualification, authenticate to the production AWS account and
publish the same repository revision:

```bash
npm run scenarios:publish -- production
```

The command verifies the active AWS account against the environment registry,
reads the artifact bucket from that environment's Terraform output, uploads each
object create-only, verifies it, and then records the approval in the configured
Convex deployment. Re-running the same publication is idempotent. Publishing new
content supersedes the prior active approval but retains its history.

Each hosted session snapshots the approval ID, environment, slug, source
manifest digest, artifact contract, publication manifest contract, schema
version, and complete approved runtime contract at request time. The runtime
contract temporarily includes the packaged starter path needed by the current
learner image. The AWS dispatcher reads no mutable lab fields, requires its own
`HOSTED_ENVIRONMENT` to exactly match the snapshot, validates the complete
contract, and passes it to the standalone task. Downloading and safely
extracting the authorized artifact remains the next standalone-session roadmap
task. Until then, the current learner image uses the approved packaged starter
path after the approval gate succeeds.
