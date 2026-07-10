import { spawn } from "node:child_process"

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

function runAwsCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("aws", args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `AWS CLI exited with code ${code ?? 1}: ${stderr.trim() || stdout.trim()}`,
          ),
        )
        return
      }

      try {
        resolve(stdout.trim() ? JSON.parse(stdout) : {})
      } catch (error) {
        reject(
          new Error(
            `AWS CLI returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
          ),
        )
      }
    })
  })
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
    ["LAB_TTL_SECONDS", String(input.ttlSeconds)],
    ["LAB_EXPIRES_AT", expiresAt],
    ["CONVEX_URL", input.convexUrl],
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
  constructor({ config = awsEcsConfigFromEnv(), execute = runAwsCli } = {}) {
    assertAwsEcsConfig(config)
    this.config = config
    this.execute = execute
  }

  async start(input) {
    const response = await this.execute([
      "ecs",
      "run-task",
      "--region",
      this.config.region,
      "--cli-input-json",
      JSON.stringify(taskInput(this.config, input)),
      "--output",
      "json",
    ])
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
    const listed = await this.execute([
      "ecs",
      "list-tasks",
      "--region",
      this.config.region,
      "--cluster",
      this.config.clusterArn,
      "--started-by",
      sessionId,
      "--output",
      "json",
    ])
    const taskArns = listed.taskArns ?? []

    for (const taskArn of taskArns) {
      await this.execute([
        "ecs",
        "stop-task",
        "--region",
        this.config.region,
        "--cluster",
        this.config.clusterArn,
        "--task",
        taskArn,
        "--reason",
        `Learning Lab session ${sessionId} stopped`,
        "--output",
        "json",
      ])
    }

    return { taskArns, stoppedCount: taskArns.length }
  }
}
