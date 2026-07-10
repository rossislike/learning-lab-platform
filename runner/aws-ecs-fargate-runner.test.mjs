import assert from "node:assert/strict"
import test from "node:test"
import {
  AwsEcsFargateRunner,
  assertAwsEcsConfig,
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
    execute: async (args) => {
      calls.push(args)
      return { tasks: [{ taskArn: "task-arn" }], failures: [] }
    },
  })

  const result = await runner.start({
    sessionId: "session-123",
    labSlug: "react-welcome",
    workspaceTemplatePath: "lab-definitions/react-welcome",
    ttlSeconds: 3600,
    convexUrl: "https://example.convex.cloud",
  })

  assert.deepEqual(result, { resourceId: "task-arn" })
  const cliInput = JSON.parse(calls[0][calls[0].indexOf("--cli-input-json") + 1])
  assert.equal(cliInput.launchType, "FARGATE")
  assert.equal(cliInput.clientToken, "session-123")
  assert.equal(cliInput.startedBy, "session-123")
  assert.deepEqual(cliInput.networkConfiguration.awsvpcConfiguration.subnets, [
    "subnet-a",
    "subnet-b",
  ])
  assert.ok(
    cliInput.overrides.containerOverrides[0].environment.some(
      (entry) =>
        entry.name === "LAB_SESSION_ID" && entry.value === "session-123",
    ),
  )
})

test("stop finds and stops every running task for the session", async () => {
  const calls = []
  const runner = new AwsEcsFargateRunner({
    config,
    execute: async (args) => {
      calls.push(args)
      if (args[1] === "list-tasks") {
        return { taskArns: ["task-a", "task-b"] }
      }
      return {}
    },
  })

  const result = await runner.stop("session-123")

  assert.equal(result.stoppedCount, 2)
  assert.equal(calls.filter((args) => args[1] === "stop-task").length, 2)
})

test("configuration validation reports all missing required values", () => {
  assert.throws(
    () => assertAwsEcsConfig({ subnetIds: [], securityGroupIds: [] }),
    /region, clusterArn, taskDefinitionArn, subnetIds, securityGroupIds/,
  )
})
