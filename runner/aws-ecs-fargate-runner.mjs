import {
  ECSClient,
  ListTasksCommand,
  RunTaskCommand,
  StopTaskCommand,
} from "@aws-sdk/client-ecs"

const requiredConfigKeys = [
  "clusterArn",
  "taskDefinitionArn",
  "subnetIds",
  "securityGroupIds",
]

export function awsEcsConfigFromEnv(env = process.env) {
  return {
    region: env.AWS_REGION || "us-east-2",
    clusterArn: env.AWS_ECS_CLUSTER_ARN,
    taskDefinitionArn: env.AWS_ECS_TASK_DEFINITION_ARN,
    subnetIds: splitList(env.AWS_ECS_SUBNET_IDS),
    securityGroupIds: splitList(env.AWS_ECS_SECURITY_GROUP_IDS),
    containerName: env.AWS_ECS_CONTAINER_NAME ?? "learning-lab-runner",
    assignPublicIp: env.AWS_ECS_ASSIGN_PUBLIC_IP === "true",
  }
}

export function assertAwsEcsConfig(config) {
  const missing = requiredConfigKeys.filter((key) => {
    const value = config[key]
    return Array.isArray(value) ? value.length === 0 : !value
  })

  if (missing.length > 0) {
    throw new Error(
      `Missing AWS ECS runner configuration: ${missing.join(", ")}`,
    )
  }
}

function splitList(value) {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function taskInput(config, input) {
  const expiresAt = new Date(
    input.expiresAt ?? Date.now() + input.ttlSeconds * 1000,
  ).toISOString()
  const environment = [
    ["LAB_RUNNER_MODE", "aws-ecs-fargate"],
    ["LAB_SESSION_ID", input.sessionId],
    ["LAB_SLUG", input.labSlug],
    ["LAB_WORKSPACE_TEMPLATE_PATH", input.workspaceTemplatePath],
    ["LAB_VALIDATION_COMMAND", input.validationCommand],
    ["LAB_TTL_SECONDS", String(input.ttlSeconds)],
    ["LAB_EXPIRES_AT", expiresAt],
    ["CONVEX_URL", input.convexUrl],
    ["RUNNER_SHARED_SECRET", input.runnerSecret],
  ]
    .filter(([, value]) => value)
    .map(([name, value]) => ({ name, value }))

  return {
    cluster: config.clusterArn,
    taskDefinition: config.taskDefinitionArn,
    launchType: "FARGATE",
    count: 1,
    clientToken: input.sessionId,
    startedBy: input.sessionId,
    enableECSManagedTags: true,
    propagateTags: "TASK_DEFINITION",
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets: config.subnetIds,
        securityGroups: config.securityGroupIds,
        assignPublicIp: config.assignPublicIp ? "ENABLED" : "DISABLED",
      },
    },
    overrides: {
      containerOverrides: [
        {
          name: config.containerName,
          environment,
        },
      ],
    },
    tags: [
      { key: "learning-lab:managed", value: "true" },
      { key: "learning-lab:session-id", value: input.sessionId },
      { key: "learning-lab:lab-slug", value: input.labSlug },
      { key: "learning-lab:expires-at", value: expiresAt },
    ],
  }
}

export class AwsEcsFargateRunner {
  constructor({ config = awsEcsConfigFromEnv(), client } = {}) {
    assertAwsEcsConfig(config)
    this.config = config
    this.client = client ?? new ECSClient({ region: config.region })
  }

  async start(input) {
    const response = await this.client.send(
      new RunTaskCommand(taskInput(this.config, input)),
    )
    const failure = response.failures?.[0]
    if (failure) {
      throw new Error(
        `ECS rejected the session task: ${failure.reason ?? "unknown reason"}`,
      )
    }

    const resourceId = response.tasks?.[0]?.taskArn
    if (!resourceId) {
      throw new Error("ECS run-task did not return a task ARN")
    }

    return { resourceId }
  }

  async check() {
    throw new Error(
      "Hosted validation runs through the per-session tools endpoint",
    )
  }

  async stop(sessionId) {
    const taskArns = []
    let nextToken

    do {
      const listed = await this.client.send(
        new ListTasksCommand({
          cluster: this.config.clusterArn,
          startedBy: sessionId,
          ...(nextToken ? { nextToken } : {}),
        }),
      )
      taskArns.push(...(listed.taskArns ?? []))
      nextToken = listed.nextToken
    } while (nextToken)

    for (const taskArn of taskArns) {
      await this.client.send(
        new StopTaskCommand({
          cluster: this.config.clusterArn,
          task: taskArn,
          reason: `Learning Lab session ${sessionId} stopped`,
        }),
      )
    }

    return { taskArns, stoppedCount: taskArns.length }
  }
}
