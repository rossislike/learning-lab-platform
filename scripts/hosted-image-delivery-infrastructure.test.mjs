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

test("GitHub OIDC trust is scoped to repository environments", () => {
  assert.match(moduleMain, /aws_iam_openid_connect_provider/)
  assert.match(moduleMain, /oidc_host = "token\.actions\.githubusercontent\.com"/)
  assert.match(moduleMain, /variable = "\${local\.oidc_host}:aud"/)
  assert.match(moduleMain, /repo:\${var\.github_repository}:environment:\${var\.environment}/)
  assert.match(moduleMain, /repo:\${var\.github_repository}:environment:production/)
  assert.doesNotMatch(moduleMain, /repo:\${var\.github_repository}:\*/)
})

test("delivery permissions are limited to ECR repositories", () => {
  assert.match(moduleMain, /ecr:GetAuthorizationToken/)
  assert.match(moduleMain, /ecr:PutImage/)
  assert.match(moduleMain, /resources = var\.ecr_repository_arns/)
  assert.doesNotMatch(moduleMain, /ecs:/)
  assert.doesNotMatch(moduleMain, /s3:/)
  assert.doesNotMatch(moduleMain, /secretsmanager:/)
})

test("staging and production roots provision distinct delivery roles", () => {
  assert.match(stagingMain, /module "github_image_delivery"/)
  assert.match(stagingMain, /create_production_promotion_reader = true/)
  assert.match(productionMain, /module "github_image_delivery"/)
  assert.doesNotMatch(productionMain, /create_production_promotion_reader = true/)
})
