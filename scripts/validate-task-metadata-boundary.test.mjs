import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import test from "node:test"

const moduleSource = await readFile(
  new URL("../infra/aws/modules/hosted-runner/main.tf", import.meta.url),
  "utf8",
)
const variablesSource = await readFile(
  new URL("../infra/aws/modules/hosted-runner/variables.tf", import.meta.url),
  "utf8",
)
const dockerfile = await readFile(
  new URL("../runner/hosted-validation.Dockerfile", import.meta.url),
  "utf8",
)
const stagingRoot = await readFile(
  new URL("../infra/aws/environments/staging/main.tf", import.meta.url),
  "utf8",
)
const productionRoot = await readFile(
  new URL("../infra/aws/environments/production/main.tf", import.meta.url),
  "utf8",
)
const validationRoot = await readFile(
  new URL("../infra/aws/terraform/main.tf", import.meta.url),
  "utf8",
)
const probeOverrides = JSON.parse(await readFile(
  new URL("./task-metadata-boundary-probe-overrides.json", import.meta.url),
  "utf8",
))

const runnerTask = moduleSource.match(
  /resource "aws_ecs_task_definition" "runner" \{([\s\S]*?)\n\}/,
)?.[1]
test("enabled learner boundary strips endpoint variables without a task role", () => {
  assert.ok(runnerTask, "runner task definition must exist")
  assert.match(
    runnerTask,
    /task_role_arn\s+= var\.enable_learner_metadata_boundary \? null : aws_iam_role\.task\.arn/,
  )
  assert.match(
    moduleSource,
    /resource "aws_iam_role" "task" \{\s+name\s+= "\$\{local\.name\}-task"/,
  )
  assert.doesNotMatch(moduleSource, /resource "aws_iam_role" "task" \{\s+count\s+=/)

  for (const name of [
    "AWS_CONTAINER_AUTHORIZATION_TOKEN",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "ECS_AGENT_URI",
    "ECS_CONTAINER_METADATA_URI",
    "ECS_CONTAINER_METADATA_URI_V4",
  ]) {
    assert.match(runnerTask, new RegExp(`"-u", "${name}"`))
  }
})

test("enabled learner boundary is non-root, capability-free, and explicit", () => {
  assert.match(runnerTask, /user\s+= "1000:1000"/)
  assert.match(runnerTask, /drop = \["ALL"\]/)
  assert.match(runnerTask, /command\s+= var\.runner_command/)
  assert.match(variablesSource, /variable "runner_command"/)
})

test("proxy bypass and validation image preserve the learner boundary", () => {
  assert.match(moduleSource, /runner_no_proxy = join\(",", concat\(/)
  assert.match(moduleSource, /var\.enable_learner_metadata_boundary \? \[\] : \[/)
  assert.match(moduleSource, /"169\.254\.169\.254"/)
  assert.match(moduleSource, /"169\.254\.170\.2"/)
  assert.match(dockerfile, /COPY --chown=node:node scripts\/smoke-test-scenarios\.mjs/)
  assert.match(dockerfile, /COPY --chown=node:node lab-definitions lab-definitions/)
})

test("only the staging root enables the learner metadata boundary", () => {
  assert.match(stagingRoot, /enable_learner_metadata_boundary\s+= true/)
  assert.match(productionRoot, /enable_learner_metadata_boundary\s+= false/)
  assert.match(validationRoot, /enable_learner_metadata_boundary\s+= false/)
})

test("live probe reports only credential field names and fails on exposure", () => {
  const command = probeOverrides.containerOverrides[0].command[2]
  const mockFetch = "globalThis.fetch = async () => ({ status: 200, json: async () => ({ AccessKeyId: 'SECRET_ACCESS_VALUE', SecretAccessKey: 'SECRET_KEY_VALUE', Token: 'SECRET_TOKEN_VALUE' }) }); "
  const result = spawnSync(process.execPath, ["-e", mockFetch + command], {
    encoding: "utf8",
    env: {
      ...process.env,
      AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/credentials/example",
      ECS_CONTAINER_METADATA_URI_V4: "http://metadata.example/v4",
    },
  })

  assert.equal(result.status, 1)
  assert.match(result.stdout, /"AccessKeyId"/)
  assert.doesNotMatch(result.stdout, /SECRET_ACCESS_VALUE|SECRET_KEY_VALUE|SECRET_TOKEN_VALUE/)
})

test("live probe passes when metadata, credentials, and link-local addresses are unavailable", () => {
  const command = probeOverrides.containerOverrides[0].command[2]
  const mockFetch = "globalThis.fetch = async () => { throw Object.assign(new Error('blocked'), { name: 'TypeError' }) }; "
  const env = { ...process.env }
  for (const name of [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "ECS_CONTAINER_METADATA_URI_V4",
  ]) delete env[name]

  const result = spawnSync(process.execPath, ["-e", mockFetch + command], {
    encoding: "utf8",
    env,
  })

  assert.equal(result.status, 0, result.stderr)
  const observations = result.stdout.trim().split("\n").map((line) => JSON.parse(line))
  assert.equal(observations.length, 5)
  assert.ok(observations.every(({ exposed }) => exposed === false))
})
