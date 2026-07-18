import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const moduleSource = await readFile(
  new URL("../infra/aws/modules/hosted-runner/main.tf", import.meta.url),
  "utf8",
)
const moduleOutputs = await readFile(
  new URL("../infra/aws/modules/hosted-runner/outputs.tf", import.meta.url),
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
const credentialRunbook = await readFile(
  new URL("../docs/aws-service-credential-boundary.md", import.meta.url),
  "utf8",
)
const roadmap = await readFile(new URL("../ROADMAP.md", import.meta.url), "utf8")

function terraformBlock(source, type, name) {
  const block = source.match(
    new RegExp(`${type} "${name}" \\{([\\s\\S]*?)\\n\\}`),
  )?.[1]
  assert.ok(block, `expected ${type} ${name}`)
  return block
}

function statementBySid(policy, sid) {
  const statement = policy.match(
    new RegExp(`statement \\{\\n\\s+sid\\s+= "${sid}"([\\s\\S]*?)\\n\\s{2}\\}`),
  )?.[1]
  assert.ok(statement, `expected statement ${sid}`)
  return statement
}

test("persistent roots enable the service secret boundary after staging qualification", () => {
  assert.match(stagingRoot, /enable_service_secret_boundary\s+= true/)
  assert.match(productionRoot, /enable_service_secret_boundary\s+= true/)
  assert.match(validationRoot, /enable_service_secret_boundary\s+= false/)
})

test("Terraform owns secret metadata but never a secret value", () => {
  assert.match(moduleSource, /resource "aws_secretsmanager_secret" "dispatcher_runner_shared_secret_protected"/)
  assert.match(moduleSource, /prevent_destroy = true/)
  assert.doesNotMatch(moduleSource, /resource "aws_secretsmanager_secret_version"/)
  assert.doesNotMatch(moduleSource, /secret_string\s+=/)
})

test("only the dispatcher execution role can retrieve the exact startup secret", () => {
  const executionPolicy = terraformBlock(
    moduleSource,
    'data "aws_iam_policy_document"',
    "dispatcher_execution",
  )
  const taskExecutionPolicy = terraformBlock(
    moduleSource,
    'data "aws_iam_policy_document"',
    "task_execution",
  )
  const secretResourcePolicy = terraformBlock(
    moduleSource,
    'data "aws_iam_policy_document"',
    "dispatcher_runner_shared_secret",
  )
  const kmsKeyPolicy = terraformBlock(
    moduleSource,
    'data "aws_iam_policy_document"',
    "service_secrets_kms",
  )

  assert.match(executionPolicy, /actions\s+= \["secretsmanager:GetSecretValue"\]/)
  assert.match(executionPolicy, /resources = \[local\.dispatcher_runner_shared_secret\.arn\]/)
  assert.match(executionPolicy, /actions\s+= \["kms:Decrypt"\]/)
  assert.match(executionPolicy, /kms:ViaService/)
  assert.match(executionPolicy, /kms:EncryptionContext:SecretARN/)
  assert.doesNotMatch(taskExecutionPolicy, /secretsmanager:|kms:Decrypt/)

  const retrievalDeny = statementBySid(
    secretResourcePolicy,
    "DenyRetrievalOutsideDispatcherExecution",
  )
  assert.match(retrievalDeny, /effect\s+= "Deny"/)
  assert.match(retrievalDeny, /actions\s+= \["secretsmanager:GetSecretValue"\]/)
  assert.match(retrievalDeny, /resources = \[local\.dispatcher_runner_shared_secret\.arn\]/)
  assert.match(retrievalDeny, /test\s+= "ArnNotEquals"/)
  assert.match(retrievalDeny, /variable = "aws:PrincipalArn"/)
  assert.match(retrievalDeny, /values\s+= \[aws_iam_role\.dispatcher_execution\[0\]\.arn\]/)

  const decryptDeny = statementBySid(
    kmsKeyPolicy,
    "DenySecretDecryptionOutsideDispatcherExecution",
  )
  assert.match(decryptDeny, /effect\s+= "Deny"/)
  assert.match(decryptDeny, /actions\s+= \["kms:Decrypt"\]/)
  assert.match(decryptDeny, /test\s+= "ArnNotEquals"/)
  assert.match(decryptDeny, /variable = "aws:PrincipalArn"/)
  assert.match(decryptDeny, /values\s+= \[aws_iam_role\.dispatcher_execution\[0\]\.arn\]/)

  const secretPolicyResource = terraformBlock(
    moduleSource,
    'resource "aws_secretsmanager_secret_policy"',
    "dispatcher_runner_shared_secret",
  )
  assert.match(secretPolicyResource, /block_public_policy = true/)
  assert.match(
    secretPolicyResource,
    /policy\s+= data\.aws_iam_policy_document\.dispatcher_runner_shared_secret\[0\]\.json/,
  )
  assert.match(
    secretPolicyResource,
    /secret_arn\s+= local\.dispatcher_runner_shared_secret\.arn/,
  )

  for (const keyResource of [
    "service_secrets_protected",
    "service_secrets_disposable",
  ]) {
    const key = terraformBlock(
      moduleSource,
      'resource "aws_kms_key"',
      keyResource,
    )
    assert.match(
      key,
      /policy\s+= data\.aws_iam_policy_document\.service_secrets_kms\[0\]\.json/,
    )
  }
})

test("dispatcher runtime role manages only the environment learner task boundary", () => {
  const runtimePolicy = terraformBlock(
    moduleSource,
    'data "aws_iam_policy_document"',
    "dispatcher_task",
  )
  const runTask = statementBySid(runtimePolicy, "RunLearnerTasks")
  const manageTasks = statementBySid(runtimePolicy, "ManageLearnerTasks")
  const tagOnCreate = statementBySid(runtimePolicy, "TagLearnerTasksOnCreate")

  assert.match(runTask, /actions\s+= \["ecs:RunTask"\]/)
  assert.match(runTask, /aws_ecs_task_definition\.runner\.arn_without_revision/)
  assert.match(runTask, /aws_ecs_cluster\.runner\.arn/)
  assert.match(runTask, /aws:RequestTag\/learning-lab:managed/)
  assert.match(runTask, /ForAllValues:StringEquals/)

  for (const action of ["ecs:DescribeTasks", "ecs:StopTask"]) {
    assert.match(manageTasks, new RegExp(action))
  }
  assert.doesNotMatch(manageTasks, /ecs:TagResource/)
  assert.match(manageTasks, /aws:ResourceTag\/learning-lab:managed/)
  assert.match(manageTasks, /aws_ecs_cluster\.runner\.arn/)

  assert.match(tagOnCreate, /actions\s+= \["ecs:TagResource"\]/)
  assert.match(tagOnCreate, /variable = "ecs:CreateAction"/)
  assert.match(tagOnCreate, /values\s+= \["RunTask"\]/)
  assert.match(tagOnCreate, /aws:RequestTag\/learning-lab:managed/)
  assert.match(tagOnCreate, /ForAllValues:StringEquals/)
  assert.equal(runtimePolicy.match(/ecs:TagResource/g)?.length, 1)

  for (const tagKey of [
    "learning-lab:expires-at",
    "learning-lab:lab-slug",
    "learning-lab:managed",
    "learning-lab:session-id",
  ]) {
    assert.match(runTask, new RegExp(tagKey))
    assert.match(tagOnCreate, new RegExp(tagKey))
  }

  const listTasks = statementBySid(runtimePolicy, "ListLearnerTasks")
  assert.match(listTasks, /actions\s+= \["ecs:ListTasks"\]/)
  assert.match(listTasks, /aws_ecs_cluster\.runner\.arn/)

  const passRoles = statementBySid(runtimePolicy, "PassLearnerRoles")
  assert.match(passRoles, /actions\s+= \["iam:PassRole"\]/)
  assert.match(passRoles, /aws_iam_role\.task_execution\.arn/)
  assert.match(passRoles, /iam:PassedToService/)
  assert.match(runtimePolicy, /iam:PassedToService/)
  assert.doesNotMatch(runtimePolicy, /secretsmanager:|kms:Decrypt/)
})

test("learner task definition contains no service secret injection", () => {
  const runnerTask = moduleSource.match(
    /resource "aws_ecs_task_definition" "runner" \{([\s\S]*?)\n\}/,
  )?.[1]

  assert.ok(runnerTask)
  assert.doesNotMatch(runnerTask, /dispatcher_runner_shared_secret|secrets\s+=/)
  assert.match(runnerTask, /task_role_arn\s+= var\.enable_learner_metadata_boundary \? null/)
})

test("the undeployed reusable learner override remains an explicit Phase 3 blocker", () => {
  assert.match(
    credentialRunbook,
    /adapter is a local prototype[\s\S]*must not be used with staging[\s\S]*Phase 3 session-bound callback roadmap task remains open/,
  )
  assert.match(
    roadmap,
    /- \[ \] Replace reusable runner and Convex credentials with dispatcher workload identity and a session-bound callback protocol/,
  )
})

test("module exposes non-sensitive identifiers needed for deployment and validation", () => {
  for (const output of [
    "dispatcher_execution_role_arn",
    "dispatcher_task_role_arn",
    "dispatcher_runner_shared_secret_arn",
    "service_secrets_kms_key_arn",
  ]) {
    assert.match(moduleOutputs, new RegExp(`output "${output}"`))
  }
})
