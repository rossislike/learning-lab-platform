# ADR 0002: Hosted Workspace Storage

- Status: Accepted
- Date: 2026-07-09
- Decision owners: Learning Lab Platform maintainers

## Context

ADR 0001 selects one standalone Amazon ECS task on AWS Fargate for each hosted learner session. The workspace must support frequent small-file reads and writes from OpenVSCode, Vite, npm, and Vitest. It is disposable after a bounded recovery window, but losing all learner changes when a task fails would create a poor learning experience.

The storage design must keep the active development loop fast, isolate session data, recover recent learner work, enforce storage limits, and make cleanup deterministic. Durable application state and validation results remain in Convex. Logs remain in CloudWatch Logs.

## Decision

Use a hybrid storage model:

- Fargate ephemeral storage is the live workspace filesystem.
- Amazon S3 stores immutable scenario artifacts and short-lived workspace checkpoints.
- Convex stores artifact and checkpoint metadata, not workspace file contents.

Amazon EFS and Amazon EBS are not part of the first hosted React runner.

## Live Workspace

Mount an ephemeral task volume at `/workspace`. OpenVSCode, Vite, npm, and Vitest all read and write this local filesystem.

Start with the Fargate default of 20 GiB on Linux platform version 1.4.0 or later. The task image and its extracted layers consume part of this allocation, so infrastructure code must keep the size configurable up to the Fargate limit. Before increasing it, measure image size, installed dependencies, workspace size, cache growth, and log growth from the hosted scenario.

The runner must enforce a per-session workspace quota below the task allocation and report a clear Convex event before disk exhaustion. Generated logs go to CloudWatch Logs instead of accumulating in `/workspace`.

Ephemeral storage uses the Fargate-managed encryption baseline. Infrastructure may configure a customer-managed KMS key later if compliance or key-control requirements justify it.

## Scenario Artifacts

Store each published scenario starter as an immutable compressed archive in a private S3 artifact bucket.

Use this key format:

```text
scenarios/{scenarioSlug}/{revision}/{sha256}.tar.gz
```

The scenario manifest records the artifact key, SHA-256 digest, uncompressed size, and revision. A published key is never overwritten. Updating a scenario produces a new revision and digest.

At session startup, the runner downloads the selected artifact, verifies its digest and size, safely extracts it into `/workspace`, and then installs dependencies. Archive extraction must reject absolute paths, parent-directory traversal, and links that escape the workspace.

Scenario archives contain source files and lockfiles. They do not contain `node_modules`, build output, editor state, secrets, or runtime logs.

## Workspace Checkpoints

Checkpoint learner-authored workspace files to a private S3 checkpoint bucket as immutable compressed archives.

Use this key format:

```text
checkpoints/{sessionId}/{sequence}-{sha256}.tar.gz
```

Create a checkpoint:

- after workspace changes have been quiet for a configurable debounce interval;
- at a hard configurable deadline while changes continue, with a target maximum of 60 seconds between dirty checkpoints;
- immediately before validation;
- after a passing validation result;
- during graceful stop or expiry cleanup when the task is still responsive.

The scenario manifest defines which learner-authored paths are eligible for checkpointing. Only matching regular files are included. Platform exclusions for dependencies, package caches, build output, temporary files, platform metadata, editor server binaries, environment files, credentials, secrets, and logs always take precedence. The runner enforces file-count, compressed-size, and uncompressed-size limits before upload.

Each archive contains a checkpoint manifest with the included relative paths and deletion tombstones for checkpoint-eligible starter files the learner removed. This makes recovery reproduce both edits and deletions. Paths and links receive the same traversal and workspace-boundary validation as scenario artifacts.

Each checkpoint records its S3 key, digest, size, sequence, and creation time in Convex only after S3 confirms the upload. The latest confirmed record is the recovery point. Failed uploads leave the previous confirmed checkpoint valid and produce an observable warning event.

## Recovery

If a session task stops unexpectedly while the session is still recoverable:

1. Start a replacement task for the same session.
2. Download and verify the original scenario artifact.
3. Download and verify the latest confirmed checkpoint.
4. Extract the scenario, apply checkpoint deletion tombstones, then overlay checkpoint files into `/workspace` using the same archive safety rules.
5. Run the scenario's dependency installation command from its lockfile.
6. Start the editor, preview, and tools processes.
7. Publish the replacement task metadata and recovered checkpoint time to Convex.

Dependencies are rebuilt instead of checkpointed. This keeps archives small and prevents native package artifacts from crossing runner-image revisions.

If no checkpoint exists, the replacement task starts from the original scenario artifact and tells the learner that no recoverable edits were available. If verification fails, the runner must not extract the archive and must mark the session errored with a diagnostic event.

## Access And Isolation

Both buckets block public access and require TLS. Objects use bucket default server-side encryption. Infrastructure can select SSE-S3 or SSE-KMS without changing the runner contract.

Session tasks do not receive permission to list either bucket or read another session's checkpoint prefix. They obtain short-lived, operation-specific access for the exact artifact or checkpoint key, such as presigned GET and PUT URLs issued by the trusted AWS dispatcher or a dedicated signing endpoint. Checkpoint uploads include a SHA-256 checksum.

URLs and signing credentials must never be written into Convex events, task logs, checkpoint archives, or learner-visible files.

## Retention And Cleanup

Scenario artifacts are retained while their scenario revision can be assigned or restored.

Checkpoint retention starts when a session reaches a terminal state. The default recovery window is 24 hours and must be configurable. A cleanup worker deletes all objects under the session checkpoint prefix after that window. A bucket lifecycle rule provides defense-in-depth expiration after seven days and removes incomplete multipart uploads.

Successful deletion is recorded in Convex. Cleanup is idempotent, so deleting an already empty prefix succeeds. Hosted TTL cleanup remains responsible for stopping compute and scheduling checkpoint deletion.

## Observability

Record these storage signals without logging file contents or signed URLs:

- scenario download and extraction duration;
- checkpoint creation and upload duration;
- checkpoint compressed and uncompressed size;
- last successful checkpoint time and sequence;
- restore duration and restored checkpoint age;
- quota violations, integrity failures, and cleanup failures.

## Alternatives Considered

### Fargate Ephemeral Storage Only

This is the simplest model and matches disposable sessions, but any task failure loses all learner changes. The checkpoint layer provides bounded recovery without changing active filesystem semantics.

### Amazon EFS

EFS persists across task replacement and supports shared access. It is not selected because the development workload benefits from local filesystem behavior, and strong per-session isolation with dynamically assigned access points would complicate task definitions, IAM, NFS networking, quotas, and cleanup.

Reconsider EFS if seamless live persistence across task replacement becomes mandatory, multiple tasks must concurrently share one workspace, or checkpoint recovery time is not acceptable.

### Amazon EBS

EBS offers durable block storage and configurable performance. It is not selected because ECS creates a new managed volume for each Fargate task. Preserving a standalone task volume does not provide a simple attach-the-same-volume recovery path, so snapshots and additional lifecycle management would still be required.

Reconsider EBS for disk-intensive scenarios, larger workspaces, or measured workloads that need predictable block storage performance.

### S3 As The Live Filesystem

S3 remains an artifact and checkpoint store rather than the active workspace. The Node and editor toolchain expects local POSIX filesystem behavior with frequent metadata and small-file operations. Object storage semantics are better suited to immutable archives.

## Consequences

- A task failure can lose changes made since the last successful checkpoint, with a target maximum of 60 seconds.
- The runner image needs safe archive, integrity verification, checkpoint, restore, and quota enforcement code.
- Recovery starts a clean task and reinstalls dependencies, so startup and restore duration must be measured.
- S3 object cleanup becomes part of hosted session cleanup and cost control.
- Infrastructure code must create two private buckets, encryption, lifecycle rules, signing permissions, and storage observability.

## References

- [Storage options for Amazon ECS tasks](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/using_data_volumes.html)
- [Fargate task ephemeral storage](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-task-storage.html)
- [Fargate security best practices](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/security-fargate.html)
- [Amazon EFS volumes with Amazon ECS](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/efs-volumes.html)
- [Amazon EBS volumes with Amazon ECS](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ebs-volumes.html)
- [Amazon S3 presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)
- [Amazon S3 lifecycle management](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lifecycle-mgmt.html)
