import { spawnSync } from "node:child_process"
import { readdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { buildScenarioArtifact } from "./scenario-artifact-bundle.mjs"
import {
  loadIsolationRegistry,
  validateIsolationRegistry,
} from "./validate-environment-isolation.mjs"

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const environments = new Set(["staging", "production"])

function execute(command, args) {
  return spawnSync(command, args, {
    encoding: "utf8",
    env: { ...process.env, AWS_PAGER: "" },
  })
}

function parseArgs(args) {
  const [environment, ...flags] = args
  const slugs = []
  let dryRun = false
  for (const flag of flags) {
    if (flag === "--dry-run") dryRun = true
    else if (flag.startsWith("--slug=") && flag.slice(7)) slugs.push(flag.slice(7))
    else return null
  }
  if (!environments.has(environment)) return null
  return { dryRun, environment, slugs }
}

async function manifestPaths(selectedSlugs) {
  const definitionsRoot = resolve(projectRoot, "lab-definitions")
  const entries = await readdir(definitionsRoot, { withFileTypes: true })
  const available = new Map(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => [
        entry.name,
        resolve(definitionsRoot, entry.name, "manifest.json"),
      ]),
  )
  const slugs = selectedSlugs.length > 0 ? [...new Set(selectedSlugs)] : [...available.keys()]
  for (const slug of slugs) {
    if (!available.has(slug)) throw new Error(`Unknown scenario slug: ${slug}`)
  }
  return slugs.sort().map((slug) => available.get(slug))
}

function successfulText(result, description) {
  if (result.status !== 0) {
    throw new Error(
      `${description} failed: ${(result.stderr || result.stdout || "unknown error").trim()}`,
    )
  }
  return result.stdout.trim()
}

function objectChecksum(hexDigest) {
  return Buffer.from(hexDigest, "hex").toString("base64")
}

function verifiedHead(result, expected) {
  if (result.status !== 0) return false
  let head
  try {
    head = JSON.parse(result.stdout)
  } catch {
    return false
  }
  return (
    head.ContentLength === expected.contents.length &&
    head.ChecksumSHA256 === objectChecksum(expected.sha256) &&
    head.Metadata?.sha256 === expected.sha256 &&
    head.Metadata?.immutable === "true"
  )
}

async function publishObject({
  bucket,
  contents,
  contentType,
  expectedBucketOwner,
  key,
  run,
  tempRoot,
  sha256,
}) {
  const bodyPath = resolve(tempRoot, sha256)
  await writeFile(bodyPath, contents, { flag: "wx", mode: 0o600 })
  const put = run("aws", [
    "s3api",
    "put-object",
    "--bucket",
    bucket,
    "--expected-bucket-owner",
    expectedBucketOwner,
    "--key",
    key,
    "--body",
    bodyPath,
    "--content-type",
    contentType,
    "--checksum-algorithm",
    "SHA256",
    "--checksum-sha256",
    objectChecksum(sha256),
    "--metadata",
    `sha256=${sha256},immutable=true`,
    "--if-none-match",
    "*",
  ])
  const head = run("aws", [
    "s3api",
    "head-object",
    "--bucket",
    bucket,
    "--expected-bucket-owner",
    expectedBucketOwner,
    "--key",
    key,
    "--checksum-mode",
    "ENABLED",
    "--output",
    "json",
  ])
  if (!verifiedHead(head, { contents, sha256 })) {
    const detail = (put.stderr || put.stdout || head.stderr || head.stdout || "verification failed").trim()
    throw new Error(`Immutable object ${key} was not verified: ${detail}`)
  }
}

function environmentConfig(registry, environment) {
  const validation = validateIsolationRegistry(registry)
  if (validation.errors.length > 0) {
    throw new Error(`Hosted environment registry is invalid: ${validation.errors.join("; ")}`)
  }
  const config = registry.environments[environment]
  if (!config.awsAccountId) throw new Error(`${environment}.awsAccountId is not configured`)
  if (!config.convexDeployment) {
    throw new Error(`${environment}.convexDeployment is not configured`)
  }
  return config
}

export async function runScenarioPublisher(args = process.argv.slice(2), deps = {}) {
  const options = parseArgs(args)
  if (!options) {
    console.error(
      "usage: npm run scenarios:publish -- <staging|production> [--slug=<slug>] [--dry-run]",
    )
    return 2
  }

  const paths = await manifestPaths(options.slugs)
  const bundles = []
  for (const path of paths) bundles.push(await buildScenarioArtifact(path))
  if (options.dryRun) {
    for (const bundle of bundles) {
      console.log(
        `[scenario-publish] dry-run ${bundle.slug} ${bundle.artifactSha256} ${bundle.manifestSha256}`,
      )
    }
    return 0
  }

  const loadRegistry = deps.loadRegistry ?? loadIsolationRegistry
  const registry = await loadRegistry()
  const config = environmentConfig(registry, options.environment)
  const run = deps.execute ?? execute
  const activeAccount = successfulText(
    run("aws", [
      "sts",
      "get-caller-identity",
      "--query",
      "Account",
      "--output",
      "text",
    ]),
    "AWS identity check",
  )
  if (activeAccount !== config.awsAccountId) {
    throw new Error(`Active AWS account does not match ${options.environment}`)
  }
  const bucket = successfulText(
    run("terraform", [
      `-chdir=infra/aws/environments/${options.environment}`,
      "output",
      "-raw",
      "artifact_bucket",
    ]),
    "Artifact bucket lookup",
  )
  if (!bucket) throw new Error("Artifact bucket output is empty")

  const tempRoot = await mkdtemp(resolve(tmpdir(), "llp-scenario-publish-"))
  try {
    for (const bundle of bundles) {
      await publishObject({
        bucket,
        contents: bundle.artifact,
        contentType: "application/vnd.learning-lab.scenario.tar",
        expectedBucketOwner: config.awsAccountId,
        key: bundle.artifactKey,
        run,
        sha256: bundle.artifactSha256,
        tempRoot,
      })
      await publishObject({
        bucket,
        contents: bundle.manifest,
        contentType: "application/vnd.learning-lab.scenario-manifest+json",
        expectedBucketOwner: config.awsAccountId,
        key: bundle.manifestKey,
        run,
        sha256: bundle.manifestSha256,
        tempRoot,
      })
      const approval = {
        artifactKey: bundle.artifactKey,
        artifactSha256: bundle.artifactSha256,
        artifactSizeBytes: bundle.artifactSizeBytes,
        environment: options.environment,
        manifestKey: bundle.manifestKey,
        manifestSha256: bundle.manifestSha256,
        slug: bundle.slug,
        sourceManifestSha256: bundle.sourceManifestSha256,
        runtime: bundle.runtime,
        schemaVersion: bundle.schemaVersion,
      }
      successfulText(
        run("npx", [
          "convex",
          "run",
          "internal.scenarioArtifacts.approve",
          JSON.stringify(approval),
          "--deployment",
          config.convexDeployment,
        ]),
        `Convex approval for ${bundle.slug}`,
      )
      console.log(
        `[scenario-publish] approved ${options.environment}/${bundle.slug} artifact=${bundle.artifactSha256} manifest=${bundle.manifestSha256}`,
      )
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
  return 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runScenarioPublisher().then(
    (status) => {
      process.exitCode = status
    },
    (error) => {
      console.error(`[scenario-publish] ${error.message}`)
      process.exitCode = 1
    },
  )
}
