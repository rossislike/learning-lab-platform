import assert from "node:assert/strict"
import test from "node:test"
import {
  AwsEcsFargateRunner,
  assertAwsEcsConfig,
  awsEcsConfigFromEnv,
} from "./aws-ecs-fargate-runner.mjs"

const config = {
  region: "us-east-2",
  clusterArn: "cluster-arn",
  taskDefinitionArn: "task-definition-arn",
  subnetIds: ["subnet-a", "subnet-b"],
  securityGroupIds: ["sg-a"],
  containerName: "runner-agent",
  assignPublicIp: false,
}

test("start dispatches one Fargate task with the session contract", async () => {
  const calls = []
  const runner = new AwsEcsFargateRunner({
    config,
    client: { send: async (command) => {
      calls.push(command)
      return { tasks: [{ taskArn: "task-arn" }], failures: [] }
    } },
  })

  const result = await runner.start({
    sessionId: "session-123",
    labSlug: "react-welcome",
    workspaceTemplatePath: "lab-definitions/react-welcome",
    validationCommand: "npm test -- --run --reporter=json",
    ttlSeconds: 3600,
    expiresAt: Date.parse("2026-07-10T12:00:00.000Z"),
    convexUrl: "https://example.convex.cloud",
    runnerSecret: "runner-secret",
  })

  assert.deepEqual(result, { resourceId: "task-arn" })
  assert.equal(calls[0].constructor.name, "RunTaskCommand")
  const commandInput = calls[0].input
  assert.equal(commandInput.launchType, "FARGATE")
  assert.equal(commandInput.clientToken, "session-123")
  assert.equal(commandInput.startedBy, "session-123")
  assert.deepEqual(commandInput.networkConfiguration.awsvpcConfiguration.subnets, [
    "subnet-a",
    "subnet-b",
  ])
  assert.ok(
    commandInput.overrides.containerOverrides[0].environment.some(
      (entry) =>
        entry.name === "LAB_SESSION_ID" && entry.value === "session-123",
    ),
  )
  assert.ok(
    commandInput.overrides.containerOverrides[0].environment.some(
      (entry) =>
        entry.name === "LAB_VALIDATION_COMMAND" &&
        entry.value === "npm test -- --run --reporter=json",
    ),
  )
  assert.ok(
    commandInput.overrides.containerOverrides[0].environment.some(
      (entry) =>
        entry.name === "RUNNER_SHARED_SECRET" &&
        entry.value === "runner-secret",
    ),
  )
  assert.ok(
    commandInput.tags.some(
      (tag) =>
        tag.key === "learning-lab:expires-at" &&
        tag.value === "2026-07-10T12:00:00.000Z",
    ),
  )
})

test("stop paginates and stops every running task for the session", async () => {
  const calls = []
  let listedPages = 0
  const runner = new AwsEcsFargateRunner({
    config,
    client: { send: async (command) => {
      calls.push(command)
      if (command.constructor.name === "ListTasksCommand") {
        listedPages += 1
        if (listedPages === 1) {
          return { taskArns: ["task-a"], nextToken: "page-2" }
        }
        return { taskArns: ["task-b"] }
      }
      return {}
    } },
  })

  const result = await runner.stop("session-123")

  assert.equal(result.stoppedCount, 2)
  assert.deepEqual(result.taskArns, ["task-a", "task-b"])
  const listCalls = calls.filter(
    (command) => command.constructor.name === "ListTasksCommand",
  )
  assert.equal(listCalls.length, 2)
  assert.equal(listCalls[0].input.nextToken, undefined)
  assert.equal(listCalls[1].input.nextToken, "page-2")
  assert.equal(
    calls.filter((command) => command.constructor.name === "StopTaskCommand").length,
    2,
  )
})

test("configuration validation reports all missing required values", () => {
  assert.throws(
    () => assertAwsEcsConfig({ subnetIds: [], securityGroupIds: [] }),
    /clusterArn, taskDefinitionArn, subnetIds, securityGroupIds/,
  )
})

test("configuration defaults to the us-east-2 region", () => {
  assert.equal(awsEcsConfigFromEnv({}).region, "us-east-2")
  assert.equal(awsEcsConfigFromEnv({ AWS_REGION: "" }).region, "us-east-2")
})
