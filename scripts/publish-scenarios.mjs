// Publish scenario bundles for the dev environment (ADR 0007, ROADMAP Phase 5):
//
//   build the learner bundle of every active v2 scenario (solutions excluded)
//   → upload bundle + sanitized manifest to the bundles bucket by digest
//   → approve each digest in the dev Convex deployment (scenarioArtifacts:approve)
//
//   npm run scenarios:publish                 # bucket from terraform output, approve on the prod deployment
//   npm run scenarios:publish -- --dry-run    # build + print, no upload, no approval
//   npm run scenarios:publish -- --scenario first-commit
//
// Requires the AWS CLI (bucket writes) and the Convex CLI (approvals go
// through `npx convex run … --prod`, an internal mutation that only an
// operator with deploy access can call). With CONVEX_DEPLOY_KEY (env or
// .env.dev) the approvals go to exactly that deployment instead. The dev
// deployment must already hold the catalog (`labs.seedScenarios`), since
// approvals are keyed by slug.

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildScenarioBundle, sanitizeBundledManifest, sha256 } from "./scenario-bundle.mjs";
import { loadCatalog, projectRoot } from "./scenario-catalog.mjs";
import { readDevOutputs } from "./dev-outputs.mjs";
import { convexTarget } from "./env-local.mjs";

function parseArgs(argv) {
  const options = { dryRun: false, slugs: [], bucket: process.env.BUNDLE_S3_BUCKET, region: process.env.AWS_REGION };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--scenario") options.slugs.push(argv[++index]);
    else if (arg === "--bucket") options.bucket = argv[++index];
    else if (arg === "--region") options.region = argv[++index];
    else throw new Error(`[scenarios-publish] unknown argument ${arg}`);
  }
  return options;
}

export function run(command, args, { cwd = projectRoot, input, env } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => reject(new Error(`${command}: ${error.message}`)));
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`${command} ${args.join(" ")} exited ${code}\n${stderr.trim()}`));
      resolveRun({ stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

/** The runtime contract Convex validates for hosted sessions (scenarioArtifactPolicy.ts). */
export function runtimeContractFor(scenario) {
  const { manifest } = scenario;
  return {
    kind: manifest.kind,
    ttlSeconds: manifest.ttlSeconds,
    workspace: manifest.workspace,
    tabs: scenario.tabs,
    ...(manifest.setup ? { setup: manifest.setup } : {}),
    stepCount: scenario.steps.length,
    ...(manifest.kind === "react" ? { react: manifest.react } : {}),
  };
}

/** Everything one approval needs, computed from the scenario directory. */
export async function describeArtifact(scenario) {
  const bundle = await buildScenarioBundle(scenario.scenarioDir, scenario.manifest);
  const sourceManifest = await readFile(resolve(scenario.scenarioDir, "manifest.json"));
  const manifestJson = `${JSON.stringify(sanitizeBundledManifest(JSON.parse(sourceManifest.toString("utf8"))), null, 2)}\n`;
  const manifestSha256 = sha256(manifestJson);
  return {
    slug: scenario.manifest.slug,
    bundle,
    manifestJson,
    approval: {
      environment: "dev",
      slug: scenario.manifest.slug,
      artifactKey: bundle.key,
      artifactSha256: bundle.sha256,
      artifactSizeBytes: bundle.sizeBytes,
      manifestKey: `scenarios/${scenario.manifest.slug}/manifests/sha256/${manifestSha256}.json`,
      manifestSha256,
      sourceManifestSha256: sha256(sourceManifest),
      runtime: runtimeContractFor(scenario),
      schemaVersion: 2,
    },
  };
}

async function objectExists(bucket, key, region) {
  try {
    await run("aws", ["s3api", "head-object", "--bucket", bucket, "--key", key, "--region", region]);
    return true;
  } catch (error) {
    // 404 for a missing key; 403 when the caller may read objects but not
    // list the bucket (S3 hides existence then). Either way: upload it, and
    // a real permission problem surfaces on the put.
    if (/\((404|403)\)|Not Found|Forbidden/.test(error.message)) return false;
    throw error;
  }
}

const stagingRoot = resolve(projectRoot, "build/publish");

async function putObject(bucket, key, region, body, contentType) {
  // Digest-addressed keys never change, so an existing object is final.
  if (await objectExists(bucket, key, region)) return "exists";
  await mkdir(stagingRoot, { recursive: true });
  const file = resolve(stagingRoot, basename(key));
  await writeFile(file, body);
  await run("aws", ["s3api", "put-object", "--bucket", bucket, "--key", key, "--region", region, "--content-type", contentType, "--body", file, "--checksum-algorithm", "SHA256"]);
  return "uploaded";
}

async function main(argv) {
  const options = parseArgs(argv);
  const { scenarios } = await loadCatalog();
  const selected = scenarios.filter(
    (scenario) => scenario.manifest.status === "active" && (options.slugs.length === 0 || options.slugs.includes(scenario.manifest.slug)),
  );
  if (selected.length === 0) throw new Error("[scenarios-publish] no active scenarios selected");
  for (const slug of options.slugs) {
    if (!selected.some((scenario) => scenario.manifest.slug === slug)) throw new Error(`[scenarios-publish] unknown or inactive scenario ${slug}`);
  }

  let bucket = options.bucket;
  let region = options.region;
  if (!options.dryRun && (!bucket || !region)) {
    const outputs = await readDevOutputs();
    bucket ??= outputs.bundles_bucket;
    region ??= outputs.aws_region;
  }

  const convex = options.dryRun ? null : await convexTarget();
  const artifacts = [];
  for (const scenario of selected) artifacts.push(await describeArtifact(scenario));

  for (const artifact of artifacts) {
    const { approval, bundle } = artifact;
    if (options.dryRun) {
      console.log(`[scenarios-publish] ${approval.slug}: bundle ${bundle.sha256.slice(0, 12)} (${bundle.sizeBytes} B, ${bundle.entryPaths.length} entries), manifest ${approval.manifestSha256.slice(0, 12)}`);
      continue;
    }
    const bundleResult = await putObject(bucket, approval.artifactKey, region, bundle.tar, "application/vnd.learning-lab.scenario.tar");
    const manifestResult = await putObject(bucket, approval.manifestKey, region, Buffer.from(artifact.manifestJson, "utf8"), "application/json");
    const { stdout } = await run("npx", convex.args(["convex", "run", "scenarioArtifacts:approve", JSON.stringify(approval), "--prod"]), { env: convex.env });
    console.log(
      `[scenarios-publish] ${approval.slug}: bundle ${bundle.sha256.slice(0, 12)} ${bundleResult}, manifest ${manifestResult}, approval ${stdout.trim().replace(/^"|"$/g, "")}`,
    );
  }
  console.log(`[scenarios-publish] ${options.dryRun ? "dry run: " : ""}${artifacts.length} scenario(s)${options.dryRun ? "" : ` published to s3://${bucket}`}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message ?? error);
    process.exitCode = 1;
  });
}
