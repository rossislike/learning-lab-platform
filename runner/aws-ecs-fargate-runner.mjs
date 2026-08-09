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
  "hostedEnvironment",
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
    hostedEnvironment: env.HOSTED_ENVIRONMENT,
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
  if (!["staging", "production"].includes(config.hostedEnvironment)) {
    throw new Error("HOSTED_ENVIRONMENT must be staging or production")
  }
}

function splitList(value) {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
}

export function assertHostedArtifactInput(input, configuredEnvironment) {
  const digestPattern = /^[0-9a-f]{64}$/
  if (typeof input.scenarioApprovalId !== "string" || !input.scenarioApprovalId) {
    throw new Error("Hosted session requires a scenario approval ID")
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.labSlug ?? "")) {
    throw new Error("Hosted session requires a valid labSlug")
  }
  if (input.hostedEnvironment !== configuredEnvironment) {
    throw new Error("Hosted session environment does not match this dispatcher")
  }
  for (const name of [
    "artifactSha256",
    "manifestSha256",
    "sourceManifestSha256",
  ]) {
    if (!digestPattern.test(input[name] ?? "")) {
      throw new Error(`Hosted session requires a valid ${name}`)
    }
  }
  if (
    !Number.isSafeInteger(input.artifactSizeBytes) ||
    input.artifactSizeBytes < 1 ||
    input.artifactSizeBytes > 64 * 1024 * 1024
  ) {
    throw new Error("Hosted session requires a valid artifactSizeBytes")
  }
  const artifactKey = `scenarios/${input.labSlug}/artifacts/sha256/${input.artifactSha256}.tar`
  const manifestKey = `scenarios/${input.labSlug}/manifests/sha256/${input.manifestSha256}.json`
  if (input.artifactKey !== artifactKey || input.manifestKey !== manifestKey) {
    throw new Error("Hosted session artifact keys must match their approved digests")
  }
  if (input.schemaVersion !== 1) {
    throw new Error("Hosted session requires scenario schemaVersion 1")
  }
  const runtime = input.runtime
  for (const name of [
    "expectedBehavior",
    "packagedWorkspaceTemplatePath",
    "previewCommand",
    "remediationFile",
    "validationCommand",
  ]) {
    if (
      typeof runtime?.[name] !== "string" ||
      runtime[name].length === 0 ||
      runtime[name].trim() !== runtime[name]
    ) {
      throw new Error(`Hosted session requires a valid runtime.${name}`)
    }
  }
  if (
    !runtime.packagedWorkspaceTemplatePath.startsWith(
      `lab-definitions/${input.labSlug}/`,
    ) ||
    runtime.packagedWorkspaceTemplatePath.includes("\\") ||
    runtime.packagedWorkspaceTemplatePath.split("/").includes("..")
  ) {
    throw new Error(
      "Hosted session requires a bound packaged workspace template path",
    )
  }
  if (
    !Number.isSafeInteger(runtime.ttlSeconds) ||
    runtime.ttlSeconds < 1 ||
    runtime.ttlSeconds > 8 * 60 * 60 ||
    !Array.isArray(runtime.expectedPorts) ||
    runtime.expectedPorts.length > 16
  ) {
    throw new Error("Hosted session requires a valid runtime contract")
  }
  const portNames = new Set()
  for (const port of runtime.expectedPorts) {
    if (
      typeof port?.name !== "string" ||
      !/^[a-z][a-z0-9-]{0,31}$/.test(port.name) ||
      portNames.has(port.name) ||
      !Number.isSafeInteger(port.containerPort) ||
      port.containerPort < 1 ||
      port.containerPort > 65535 ||
      typeof port.public !== "boolean"
    ) {
      throw new Error("Hosted session requires valid runtime.expectedPorts")
    }
    portNames.add(port.name)
  }
}

function taskInput(config, input) {
  assertHostedArtifactInput(input, config.hostedEnvironment)
  const expiresAt = new Date(
    input.expiresAt ?? Date.now() + input.ttlSeconds * 1000,
  ).toISOString()
  const environment = [
    ["LAB_RUNNER_MODE", "aws-ecs-fargate"],
    ["LAB_SESSION_ID", input.sessionId],
    ["LAB_SCENARIO_APPROVAL_ID", input.scenarioApprovalId],
    ["LAB_SLUG", input.labSlug],
    ["LAB_WORKSPACE_TEMPLATE_PATH", input.runtime.packagedWorkspaceTemplatePath],
    ["LAB_VALIDATION_COMMAND", input.runtime.validationCommand],
    ["LAB_PREVIEW_COMMAND", input.runtime.previewCommand],
    ["LAB_EXPECTED_BEHAVIOR", input.runtime.expectedBehavior],
    ["LAB_EXPECTED_PORTS", JSON.stringify(input.runtime.expectedPorts)],
    ["LAB_REMEDIATION_FILE", input.runtime.remediationFile],
    ["LAB_APPROVED_TTL_SECONDS", String(input.runtime.ttlSeconds)],
    ["LAB_HOSTED_ENVIRONMENT", input.hostedEnvironment],
    ["LAB_ARTIFACT_KEY", input.artifactKey],
    ["LAB_ARTIFACT_SHA256", input.artifactSha256],
    ["LAB_ARTIFACT_SIZE_BYTES", String(input.artifactSizeBytes)],
    ["LAB_SCENARIO_MANIFEST_KEY", input.manifestKey],
    ["LAB_SCENARIO_MANIFEST_SHA256", input.manifestSha256],
    ["LAB_SOURCE_MANIFEST_SHA256", input.sourceManifestSha256],
    ["LAB_SCENARIO_SCHEMA_VERSION", String(input.schemaVersion)],
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
