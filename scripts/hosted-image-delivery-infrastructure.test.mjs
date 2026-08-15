import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const moduleMain = await readFile(
  new URL("../infra/aws/modules/github-image-delivery/main.tf", import.meta.url),
  "utf8",
)
const stagingMain = await readFile(
  new URL("../infra/aws/environments/staging/main.tf", import.meta.url),
  "utf8",
)
const productionMain = await readFile(
  new URL("../infra/aws/environments/production/main.tf", import.meta.url),
  "utf8",
)
const accountSecurityMain = await readFile(
  new URL("../infra/aws/account-security/main.tf", import.meta.url),
  "utf8",
)
const stagingBackend = await readFile(
  new URL("../infra/aws/environments/staging/staging.s3.tfbackend.example", import.meta.url),
  "utf8",
)
const productionBackend = await readFile(
  new URL("../infra/aws/environments/production/production.s3.tfbackend.example", import.meta.url),
  "utf8",
)

test("GitHub OIDC trust is scoped to repository environments", () => {
  assert.match(accountSecurityMain, /resource "aws_iam_openid_connect_provider" "github_actions"/)
  assert.doesNotMatch(moduleMain, /resource "aws_iam_openid_connect_provider"/)
  assert.match(moduleMain, /oidc_host = "token\.actions\.githubusercontent\.com"/)
  assert.match(moduleMain, /identifiers = \[var\.github_oidc_provider_arn\]/)
  assert.match(moduleMain, /variable = "\${local\.oidc_host}:aud"/)
  assert.match(moduleMain, /repo:\${var\.github_repository}:environment:\${var\.environment}/)
  assert.doesNotMatch(moduleMain, /repo:\${var\.github_repository}:\*/)
})

test("delivery permissions separate production writes from exact staging reads", () => {
  assert.match(moduleMain, /ecr:GetAuthorizationToken/)
  assert.match(moduleMain, /ecr:PutImage/)
  assert.match(moduleMain, /resources = var\.ecr_repository_arns/)
  const sourceStart = moduleMain.indexOf('sid = "ReadStagingPromotionSources"')
  const sourceEnd = moduleMain.indexOf(
    "resources = var.promotion_source_ecr_repository_arns",
    sourceStart,
  )
  assert.notEqual(sourceStart, -1)
  assert.notEqual(sourceEnd, -1)
  const sourcePermissions = moduleMain.slice(sourceStart, sourceEnd)
  for (const action of [
    "ecr:BatchCheckLayerAvailability",
    "ecr:BatchGetImage",
    "ecr:DescribeImages",
    "ecr:GetDownloadUrlForLayer",
    "ecr:ListImages",
  ]) assert.match(sourcePermissions, new RegExp(action))
  for (const action of [
    "ecr:CompleteLayerUpload",
    "ecr:InitiateLayerUpload",
    "ecr:PutImage",
    "ecr:UploadLayerPart",
  ]) assert.doesNotMatch(sourcePermissions, new RegExp(action))
  assert.doesNotMatch(moduleMain, /ecs:/)
  assert.doesNotMatch(moduleMain, /s3:/)
  assert.doesNotMatch(moduleMain, /secretsmanager:/)
})

test("staging and production roots provision distinct delivery roles", () => {
  assert.match(stagingMain, /module "github_image_delivery"/)
  assert.match(stagingMain, /data "aws_iam_openid_connect_provider" "github_actions"/)
  assert.match(stagingMain, /github_oidc_provider_arn\s+= data\.aws_iam_openid_connect_provider\.github_actions\.arn/)
  assert.doesNotMatch(stagingMain, /promotion_source_ecr_repository_arns/)
  assert.match(productionMain, /module "github_image_delivery"/)
  assert.match(productionMain, /data "aws_iam_openid_connect_provider" "github_actions"/)
  assert.match(productionMain, /github_oidc_provider_arn\s+= data\.aws_iam_openid_connect_provider\.github_actions\.arn/)
  assert.match(productionMain, /promotion_source_ecr_repository_arns\s+= local\.staging_ecr_repository_arns/)
  for (const suffix of ["runner", "dispatcher", "session-gateway", "egress-proxy"]) {
    assert.match(productionMain, new RegExp(`"${suffix}"`))
  }
  assert.doesNotMatch(moduleMain, /promotion_reader/)
})

test("shared-account environments retain separate Terraform state", () => {
  assert.match(stagingBackend, /key\s+= "learning-lab-platform\/staging\/terraform\.tfstate"/)
  assert.match(productionBackend, /key\s+= "learning-lab-platform\/production\/terraform\.tfstate"/)
  assert.notEqual(stagingBackend, productionBackend)
})
