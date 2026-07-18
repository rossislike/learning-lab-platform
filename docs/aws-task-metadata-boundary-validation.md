# AWS task metadata boundary validation

The hosted learner task metadata boundary was validated in staging and
production on 2026-07-18.

## AWS constraint and design

Fargate platform version 1.4.0 and later injects an opaque
`ECS_CONTAINER_METADATA_URI_V4` into every container. Fargate does not support
the ECS agent setting used on EC2 hosts to block IMDS. The learner boundary
therefore uses these controls together:

- `awsvpc` Fargate isolation keeps EC2 IMDS and unrelated link-local addresses
  unreachable;
- the learner task has no task IAM role, so ECS does not vend task-role
  credentials;
- the agent-only execution role remains available to ECS for image pulls and
  log delivery but is not exposed inside the learner container;
- the container entrypoint removes AWS credential, ECS agent, and ECS metadata
  endpoint variables before starting the learner command;
- the learner command runs as UID and GID `1000:1000` with all Linux
  capabilities dropped; and
- link-local addresses are absent from both proxy bypass variables.

AWS documents that the Fargate v4 metadata endpoint is enabled by default and
that task roles cause ECS to inject a credential URI. See the
[Fargate task metadata endpoint](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-metadata-endpoint-v4-fargate.html),
[ECS IAM role guidance](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/security-iam-roles.html),
and [ECS network security guidance](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/security-network.html).

## Repeatable environment verification

The checked-in probe logs only endpoint availability, HTTP status, and JSON
field names. It never logs response values. The commands below default to the
staging Terraform root. Set `TARGET_ROOT` to
`infra/aws/environments/production` to verify production.

Initialize the selected root with its existing backend, then run:

```sh
AWS_REGION=us-east-2
TARGET_ROOT=${TARGET_ROOT:-infra/aws/environments/staging}
TARGET_CLUSTER=$(terraform -chdir="$TARGET_ROOT" output -raw ecs_cluster_arn)
TARGET_TASK_DEFINITION=$(terraform -chdir="$TARGET_ROOT" output -raw ecs_task_definition_arn)
TARGET_SUBNET=$(terraform -chdir="$TARGET_ROOT" output -json private_subnet_ids | jq -r '.[0]')
TARGET_SECURITY_GROUP=$(terraform -chdir="$TARGET_ROOT" output -raw session_security_group_id)
TARGET_LOG_GROUP=$(terraform -chdir="$TARGET_ROOT" output -raw runner_log_group)
TARGET_NETWORK="awsvpcConfiguration={subnets=[$TARGET_SUBNET],securityGroups=[$TARGET_SECURITY_GROUP],assignPublicIp=DISABLED}"

aws ecs describe-task-definition \
  --region "$AWS_REGION" \
  --task-definition "$TARGET_TASK_DEFINITION" \
  --output json | \
  jq -e '.taskDefinition | {taskRoleArn: (.taskRoleArn // null), executionRoleArn} | select(.taskRoleArn == null and (.executionRoleArn | type == "string"))'

PROBE_TASK_ARN=$(aws ecs run-task \
  --region "$AWS_REGION" \
  --cluster "$TARGET_CLUSTER" \
  --task-definition "$TARGET_TASK_DEFINITION" \
  --launch-type FARGATE \
  --network-configuration "$TARGET_NETWORK" \
  --overrides file://scripts/task-metadata-boundary-probe-overrides.json \
  --query 'tasks[0].taskArn' \
  --output text)
aws ecs wait tasks-stopped \
  --region "$AWS_REGION" \
  --cluster "$TARGET_CLUSTER" \
  --tasks "$PROBE_TASK_ARN"
PROBE_TASK_ID=${PROBE_TASK_ARN##*/}
aws ecs describe-tasks \
  --region "$AWS_REGION" \
  --cluster "$TARGET_CLUSTER" \
  --tasks "$PROBE_TASK_ARN" \
  --output json | \
  jq -e '.tasks[0].containers | all(.exitCode == 0)'
aws logs get-log-events \
  --region "$AWS_REGION" \
  --log-group-name "$TARGET_LOG_GROUP" \
  --log-stream-name "ecs/learning-lab-runner/$PROBE_TASK_ID" \
  --query 'events[].message' \
  --output text
```

The probe must report `exposed: false` for ambient credential environment
variables, EC2 IMDS, the unrelated link-local address, ECS task metadata, and
task-role credentials. The task and every managed sidecar must exit with code
`0`. The task definition query proves that the learner has no task identity
while the ECS agent retains its separate execution identity.

Finally, launch the task without an override to verify the normal scenario:

```sh
SCENARIO_TASK_ARN=$(aws ecs run-task \
  --region "$AWS_REGION" \
  --cluster "$TARGET_CLUSTER" \
  --task-definition "$TARGET_TASK_DEFINITION" \
  --launch-type FARGATE \
  --network-configuration "$TARGET_NETWORK" \
  --query 'tasks[0].taskArn' \
  --output text)
aws ecs wait tasks-stopped \
  --region "$AWS_REGION" \
  --cluster "$TARGET_CLUSTER" \
  --tasks "$SCENARIO_TASK_ARN"
aws ecs describe-tasks \
  --region "$AWS_REGION" \
  --cluster "$TARGET_CLUSTER" \
  --tasks "$SCENARIO_TASK_ARN" \
  --output json | \
  jq -e '.tasks[0].containers | all(.exitCode == 0)'
SCENARIO_TASK_ID=${SCENARIO_TASK_ARN##*/}
aws logs get-log-events \
  --region "$AWS_REGION" \
  --log-group-name "$TARGET_LOG_GROUP" \
  --log-stream-name "ecs/learning-lab-runner/$SCENARIO_TASK_ID" \
  --query 'events[].message' \
  --output text
```

The runner log must confirm that the starter check failed, the known solution
was applied, and the solution check passed.

## Staging baseline reproduction

Task definition revision `4` ran a redacted Node probe from the same learner
container boundary. It logged only endpoint availability, HTTP status, and
JSON field names. It never logged credential values.

| Probe | Baseline result |
| --- | --- |
| EC2 IMDS at `169.254.169.254` | Unreachable |
| Unrelated link-local address | Unreachable |
| ECS task metadata | HTTP 200 with metadata fields |
| Task-role credentials | HTTP 200 with credential field names |

The baseline task was
`arn:aws:ecs:us-east-2:442359104502:task/learning-lab-platform-staging/e180d1bd92de483db61bd30337f4e855`.

## Staging hardened verification

Staging task definition revision `6` uses runner image digest
`sha256:175815b490283ca36444dcec9a2485bc6d59230a5274eb8b524a6f496e8c500a`.
The live definition reported no `taskRoleArn`, kept the separate execution
role, ran as `1000:1000`, and dropped all capabilities.

The redacted probe produced these results:

| Probe | Hardened result |
| --- | --- |
| EC2 IMDS at `169.254.169.254` | Unreachable |
| Unrelated link-local address | Unreachable |
| ECS task metadata | Endpoint variable absent |
| Task-role credentials | Endpoint variable absent |

The hardened probe task was
`arn:aws:ecs:us-east-2:442359104502:task/learning-lab-platform-staging/cdcaad0ab45a4276ab2022ed6888949f`.

A separate unmodified task launch exercised the hosted scenario command. It
installed dependencies, confirmed the starter check failed, applied the known
solution, and confirmed the solution passed. Both the learner container and
the GuardDuty sidecar exited with code `0`. The scenario task was
`arn:aws:ecs:us-east-2:442359104502:task/learning-lab-platform-staging/58b45898387e4197aaa04b79cf67dbda`.

## Production baseline reproduction

Production task definition revision `4` used the previously qualified baseline
runner image digest
`sha256:c41aa11a664c9b5599dbefe2c2134be8a9dce48a8fd3da8084afd75dd2ca221c`.
The redacted probe reproduced the staging baseline: EC2 IMDS and the unrelated
link-local address were unreachable, while ECS task metadata and task-role
credentials both returned HTTP 200. The learner container exited with code `1`
because the probe correctly detected exposure. The baseline production task was
`arn:aws:ecs:us-east-2:442359104502:task/learning-lab-platform-production/bf1231d558394940a1fd6c8e0d146ebc`.

## Production hardened verification

Production task definition revision `5` uses the staging-qualified runner image
digest
`sha256:175815b490283ca36444dcec9a2485bc6d59230a5274eb8b524a6f496e8c500a`.
The live definition reported no `taskRoleArn`, retained the separate execution
role, ran as `1000:1000`, and dropped all capabilities.

The redacted probe reported EC2 IMDS and the unrelated link-local address as
unreachable. ECS task metadata and task-role credential endpoint variables were
absent. The learner and GuardDuty containers exited with code `0`. The hardened
production probe task was
`arn:aws:ecs:us-east-2:442359104502:task/learning-lab-platform-production/20fff64d4ffe480987d5fdbc65a6236a`.

The normal production scenario installed dependencies, confirmed the starter
check failed, applied the known solution, and confirmed the solution passed.
The learner and GuardDuty containers exited with code `0`. The production
scenario task was
`arn:aws:ecs:us-east-2:442359104502:task/learning-lab-platform-production/df86d625c2d24bf1aa97e4d1eff69b37`.
