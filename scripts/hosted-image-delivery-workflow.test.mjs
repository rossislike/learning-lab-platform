import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const workflow = await readFile(
  new URL("../.github/workflows/hosted-image-delivery.yml", import.meta.url),
  "utf8",
)
const roadmap = await readFile(new URL("../ROADMAP.md", import.meta.url), "utf8")
const runbook = await readFile(
  new URL("../docs/hosted-image-delivery.md", import.meta.url),
  "utf8",
)

function job(name, nextName) {
  const start = workflow.indexOf(`  ${name}:`)
  const end = nextName ? workflow.indexOf(`  ${nextName}:`, start + 1) : workflow.length
  assert.notEqual(start, -1, `missing ${name} job`)
  assert.notEqual(end, -1, `missing ${nextName} job`)
  return workflow.slice(start, end)
}

test("workflow provides unprivileged ARM64 PR build, scan, and SBOM checks", () => {
  const value = job("pull-request-images", "validate-release")
  assert.match(workflow, /pull_request:/)
  assert.match(value, /platforms: linux\/arm64/)
  assert.match(value, /push: false/)
  assert.match(value, /aquasecurity\/trivy-action@0\.32\.0/)
  assert.match(value, /anchore\/sbom-action@v0/)
  assert.match(value, /upload-artifact: false/)
  assert.doesNotMatch(value, /configure-aws-credentials/)
  assert.doesNotMatch(value, /cosign sign/)
})

test("release validation blocks mutation until isolation and source checks pass", () => {
  const validation = job("validate-release", "staging-images")
  const staging = job("staging-images", "staging-manifest")
  const production = job("production-promotion")
  assert.match(validation, /test "\$\{GITHUB_REF\}" = "\$\{EXPECTED_REF\}"/)
  assert.match(validation, /npm run env:isolation:require-ready/)
  assert.match(validation, /test "\$\{staging_account_id\}" != "\$\{production_account_id\}"/)
  assert.match(staging, /needs:[\s\S]*- validate-release/)
  assert.match(production, /needs: validate-release/)
  assert.match(staging, /Verify staging AWS account/)
  assert.match(production, /Verify staging AWS account/)
  assert.match(production, /Verify production AWS account/)
})

test("staging signs and identity-verifies scanned immutable digests", () => {
  const value = job("staging-images", "staging-manifest")
  assert.match(value, /steps\.image\.outputs\.repository }}@\${{ steps\.build\.outputs\.digest }}/)
  assert.match(value, /severity: CRITICAL,HIGH/)
  assert.match(value, /exit-code: "1"/)
  assert.match(value, /upload-artifact: false/)
  assert.match(value, /cosign sign --yes/)
  assert.match(value, /cosign verify/)
  assert.match(value, /--certificate-identity/)
  assert.match(value, /--certificate-oidc-issuer/)
  assert.doesNotMatch(value, /:latest/)
})

test("production copies and verifies staging digests without rebuilding", () => {
  const value = job("production-promotion")
  assert.match(value, /run-id: \${{ inputs\.staging_run_id }}/)
  assert.match(value, /docker buildx imagetools create/)
  assert.match(value, /imagetools inspect --raw/)
  assert.match(value, /test "\$\{actual\}" = "\$\{digest\}"/)
  assert.match(value, /\.sourceCommit == \$source_sha/)
  assert.match(value, /\.repository ==/)
  assert.match(value, /stagingImageUri/)
  assert.match(value, /cosign verify/)
  assert.doesNotMatch(value, /docker\/build-push-action/)
})

test("all deployable hosted images are included", () => {
  for (const expected of [
    "learner-session",
    "dispatcher",
    "gateway",
    "egress-proxy",
  ]) {
    assert.match(workflow, new RegExp(`"name":"${expected}"`))
  }
})

test("mutable action refs remain an explicit completion blocker", () => {
  assert.match(workflow, /uses: actions\/checkout@v4/)
  assert.match(
    roadmap,
    /- \[ \] Add CI image builds for ARM64,[^\n]+authenticated commit SHA/,
  )
  assert.match(runbook, /roadmap item remains incomplete until external action references are pinned/i)
})
