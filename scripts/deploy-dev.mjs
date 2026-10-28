// Deploy the dev environment (ADR 0007) on top of the Terraform root
// infra/aws/environments/dev. Everything it needs comes from
// `terraform output -json` and the ignored `.env.dev` file.
//
//   npm run deploy:dev                 # all: images → convex → chart → dns → scenarios → frontend
//   npm run deploy:dev -- images       # build + push both images to ECR (IMAGE_PLATFORMS, default linux/amd64,linux/arm64)
//   npm run deploy:dev -- convex       # convex deploy to the dev deployment + seed the catalog
//   npm run deploy:dev -- chart        # network-policy switch + helm upgrade on the EKS cluster with the pushed digests
//                                      # (build/dev-images.json, else the images tagged IMAGE_TAG / the clean HEAD in ECR)
//   npm run deploy:dev -- dns          # point *.dev.<domain> at the Ingress load balancer
//   npm run deploy:dev -- scenarios    # publish + approve scenario bundles
//   npm run deploy:dev -- frontend     # vite build → S3 sync → CloudFront invalidation
//   npm run deploy:dev -- status       # pods, ingress, URLs
//   npm run deploy:dev -- teardown     # helm uninstall → wait for the ALB to go → delete the *.dev CNAME
//                                      # (then npm run infra:dev:destroy)
//
// .env.dev (ignored) holds the browser/Convex settings for dev:
//   VITE_CONVEX_URL=https://upbeat-crab-254.convex.cloud
//   VITE_CLERK_PUBLISHABLE_KEY=pk_test_…
//   RUNNER_SHARED_SECRET=…            (deploy:dev convex writes it to the Convex deployment)
//   CONVEX_DEPLOY_KEY=prod:upbeat-crab-254|…   (optional, recommended: pins every Convex CLI call to that deployment)
//
// Environment: IMAGE_TAG (image tag; CI passes the commit SHA, a full SHA is
// shortened to 12), IMAGE_PLATFORMS, BUILDX_CACHE (e.g. type=gha in CI: adds
// --cache-from/--cache-to …,mode=max to both image builds).
//
// Requires: aws (logged in to account 442359104502), docker buildx with a
// multi-platform builder, kubectl, helm, terraform (applied), and the Convex
// CLI (logged in to the project, or CONVEX_DEPLOY_KEY).

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readDevOutputs } from "./dev-outputs.mjs";
import { convexTarget, envDevUrl, readEnvLocalValue } from "./env-local.mjs";
import { projectRoot } from "./scenario-catalog.mjs";

const CHART = "deploy/helm/learning-lab";
const RELEASE = "learning-lab";
const NAMESPACE = "learning-lab";
const SESSIONS_NAMESPACE = "sessions";
const KUBE_CONTEXT = "learning-lab-dev";
const BUILD_DIR = resolve(projectRoot, "build");
const IMAGE_RECORD = resolve(BUILD_DIR, "dev-images.json");
const DEFAULT_IMAGE_PLATFORMS = "linux/amd64,linux/arm64";

function fail(message) {
  throw new Error(`[deploy-dev] ${message}`);
}

/** Replaces every occurrence of each secret in `text` (error messages carry argv and stderr). */
export function redactSecrets(text, secrets = []) {
  let out = String(text);
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length > 0) out = out.split(secret).join("***");
  }
  return out;
}

function run(command, args, { capture = false, env, cwd = projectRoot, allowFailure = false, redact = [], input } = {}) {
  return new Promise((resolveRun, reject) => {
    const stdin = input === undefined ? (capture ? "ignore" : "inherit") : "pipe";
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: [stdin, capture ? "pipe" : "inherit", capture ? "pipe" : "inherit"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => reject(new Error(`${command} not found: ${error.message}`)));
    child.on("close", (code) => {
      if (code !== 0 && !allowFailure) return reject(new Error(redactSecrets(`${command} ${args.join(" ")} exited ${code}\n${stderr}`, redact)));
      resolveRun({ code, stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/** Terraform outputs always; `.env.dev` values are checked by the steps that use them. */
async function settings() {
  const outputs = await readDevOutputs();
  const value = async (name) => process.env[name] ?? (await readEnvLocalValue(name, envDevUrl));
  return {
    outputs,
    convexUrl: await value("VITE_CONVEX_URL"),
    clerkKey: await value("VITE_CLERK_PUBLISHABLE_KEY"),
    runnerSecret: await value("RUNNER_SHARED_SECRET"),
  };
}

const REQUIRED_SETTINGS = {
  convexUrl: "VITE_CONVEX_URL is required (.env.dev, or CI variables/secrets)",
  clerkKey: "VITE_CLERK_PUBLISHABLE_KEY is required for the dev frontend (.env.dev, or CI variables/secrets)",
  runnerSecret: "RUNNER_SHARED_SECRET is required (.env.dev, or CI variables/secrets); deploy:dev convex writes it to the Convex deployment",
};

function requireSettings(config, ...names) {
  for (const name of names) if (!config[name]) fail(REQUIRED_SETTINGS[name]);
}

/** IMAGE_TAG as given (a full 40-hex commit SHA is shortened to 12 like `git rev-parse --short=12`). */
export function normalizeImageTag(value) {
  const tag = String(value).trim();
  const short = /^[0-9a-f]{40}$/.test(tag) ? tag.slice(0, 12) : tag;
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(short)) fail(`IMAGE_TAG ${JSON.stringify(value)} is not a valid image tag`);
  return short;
}

/** `--cache-from/--cache-to` for one image when BUILDX_CACHE is set (gha caches get a per-image scope). */
export function buildxCacheArgs(cache, scope) {
  if (!cache) return [];
  const ref = cache.startsWith("type=gha") && !/(^|,)scope=/.test(cache) ? `${cache},scope=${scope}` : cache;
  return ["--cache-from", ref, "--cache-to", `${ref},mode=max`];
}

/**
 * IMAGE_TAG when set (CI: the commit SHA — terraform init or npm may touch
 * tracked files on a runner, which must not make every CI tag "dirty");
 * otherwise the commit SHA, and a dirty tree gets a unique `-dirty-<time>`
 * suffix so a tag never names two different builds.
 */
async function imageTag() {
  if (process.env.IMAGE_TAG) return normalizeImageTag(process.env.IMAGE_TAG);
  const { stdout } = await run("git", ["rev-parse", "--short=12", "HEAD"], { capture: true });
  const { stdout: changes } = await run("git", ["status", "--porcelain"], { capture: true });
  const sha = stdout.trim();
  return changes.trim() ? `${sha}-dirty-${Math.floor(Date.now() / 1000)}` : sha;
}

async function imageDigest(repository, tag, region) {
  const { code, stdout } = await run(
    "aws",
    ["ecr", "describe-images", "--repository-name", repository, "--image-ids", `imageTag=${tag}`, "--region", region, "--query", "imageDetails[0].imageDigest", "--output", "text"],
    { capture: true, allowFailure: true },
  );
  if (code !== 0) fail(`no image ${repository}:${tag} in ECR (run npm run deploy:dev -- images, or set IMAGE_TAG to a pushed tag)`);
  const digest = stdout.trim();
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) fail(`could not read the digest of ${repository}:${tag}`);
  return digest;
}

async function images({ outputs }) {
  const region = outputs.aws_region;
  const registry = outputs.ecr_repository_urls.platform.split("/")[0];
  const platforms = process.env.IMAGE_PLATFORMS || DEFAULT_IMAGE_PLATFORMS;
  const tag = await imageTag();
  const { stdout: password } = await run("aws", ["ecr", "get-login-password", "--region", region], { capture: true });
  // docker login takes the password on stdin.
  await run("docker", ["login", "--username", "AWS", "--password-stdin", registry], { input: password });

  const sessionRef = `${outputs.ecr_repository_urls["session-workspace"]}:${tag}`;
  const platformRef = `${outputs.ecr_repository_urls.platform}:${tag}`;
  // build.sh reads BUILDX_CACHE itself (scope session-workspace).
  await run("bash", ["images/session-workspace/build.sh", "--push", sessionRef], { env: { PLATFORMS: platforms } });
  await run("docker", [
    "buildx", "build", "--platform", platforms, "-f", "images/platform/Dockerfile", "-t", platformRef,
    ...buildxCacheArgs(process.env.BUILDX_CACHE, "platform"),
    "--push", ".",
  ]);

  const record = {
    tag,
    platforms,
    builtAt: new Date().toISOString(),
    session: `${outputs.ecr_repository_urls["session-workspace"]}@${await imageDigest("learning-lab/session-workspace", tag, region)}`,
    platform: `${outputs.ecr_repository_urls.platform}@${await imageDigest("learning-lab/platform", tag, region)}`,
  };
  await mkdir(BUILD_DIR, { recursive: true });
  await writeFile(IMAGE_RECORD, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`[deploy-dev] images pushed (${platforms}):\n  ${record.session}\n  ${record.platform}`);
  return record;
}

/**
 * The digests `images` recorded, or — on a fresh machine or CI runner, e.g.
 * `deploy:dev chart` on its own — the images tagged IMAGE_TAG (or the clean
 * HEAD commit) in ECR.
 */
async function readImageRecord({ outputs }) {
  try {
    return JSON.parse(await readFile(IMAGE_RECORD, "utf8"));
  } catch {
    // fall back to ECR below
  }
  const tag = await imageTag();
  if (tag.includes("-dirty-")) {
    fail("no pushed images recorded (build/dev-images.json) and the working tree is dirty; run npm run deploy:dev -- images first, or set IMAGE_TAG to a pushed tag");
  }
  const region = outputs.aws_region;
  console.log(`[deploy-dev] no build/dev-images.json; deploying the images tagged ${tag} in ECR`);
  return {
    tag,
    session: `${outputs.ecr_repository_urls["session-workspace"]}@${await imageDigest("learning-lab/session-workspace", tag, region)}`,
    platform: `${outputs.ecr_repository_urls.platform}@${await imageDigest("learning-lab/platform", tag, region)}`,
  };
}

async function kubeconfig({ outputs }) {
  await run("aws", ["eks", "update-kubeconfig", "--name", outputs.cluster_name, "--region", outputs.aws_region, "--alias", KUBE_CONTEXT], { capture: true });
}

/**
 * EKS Auto Mode enforces NetworkPolicy only once this kube-system ConfigMap
 * turns the network-policy controller on. It is applied here (server-side,
 * idempotent) rather than from the chart: Auto Mode may already have the
 * ConfigMap, and Helm refuses to adopt objects it did not create.
 */
async function enableNetworkPolicies() {
  const configMap = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { name: "amazon-vpc-cni", namespace: "kube-system" },
    data: { "enable-network-policy-controller": "true" },
  };
  await run(
    "kubectl",
    ["--context", KUBE_CONTEXT, "apply", "--server-side", "--field-manager=learning-lab-deploy-dev", "--force-conflicts", "-f", "-"],
    { capture: true, input: JSON.stringify(configMap) },
  );
}

/**
 * Secrets go to Helm in a values file (mode 0600, removed afterwards), not
 * on the command line: argv is visible to other local processes and would
 * end up in error messages, and --set-string mangles `,` and `\`.
 */
async function withSecretValues(values, callback) {
  await mkdir(BUILD_DIR, { recursive: true });
  const file = resolve(BUILD_DIR, `dev-secrets-${process.pid}-${randomBytes(4).toString("hex")}.yaml`);
  // JSON is valid YAML, and JSON.stringify quotes and escapes every value.
  await writeFile(file, `${JSON.stringify(values)}\n`, { mode: 0o600, flag: "wx" });
  try {
    return await callback(file);
  } finally {
    await rm(file, { force: true });
  }
}

async function chart(config) {
  requireSettings(config, "convexUrl", "runnerSecret");
  const { outputs, convexUrl, runnerSecret } = config;
  const record = await readImageRecord(config);
  await kubeconfig(config);
  await enableNetworkPolicies();
  await withSecretValues({ convexUrl, runnerSecret }, (secretsFile) =>
    run(
      "helm",
      [
        "upgrade", "--install", RELEASE, CHART,
        "--kube-context", KUBE_CONTEXT,
        "--namespace", NAMESPACE, "--create-namespace",
        "-f", `${CHART}/values-dev.yaml`,
        "-f", secretsFile,
        "--set-string", `images.session=${record.session}`,
        "--set-string", `images.platform=${record.platform}`,
        "--set-string", `gateway.hostSuffix=${outputs.environment_domain}`,
        "--set-string", `gateway.appOrigin=${outputs.app_url}`,
        "--set-string", `gateway.ingress.certificateArn=${outputs.alb_certificate_arn}`,
        "--set-string", `bundle.s3Bucket=${outputs.bundles_bucket}`,
        "--set-string", `bundle.region=${outputs.aws_region}`,
        "--set-string", `sessions.dnsServiceIp=${outputs.cluster_dns_ip}`,
        "--wait", "--timeout", "300s",
      ],
      { redact: [runnerSecret] },
    ),
  );
  await run("kubectl", ["--context", KUBE_CONTEXT, "-n", NAMESPACE, "rollout", "status", "deployment/llp-gateway", "--timeout=180s"]);
  const hostname = await ingressHostname();
  console.log(`[deploy-dev] chart installed; ingress load balancer: ${hostname ?? "(pending)"}`);
}

async function ingressHostname({ waitMs = 0 } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const { stdout } = await run(
      "kubectl",
      ["--context", KUBE_CONTEXT, "-n", NAMESPACE, "get", "ingress", "llp-gateway", "-o", "jsonpath={.status.loadBalancer.ingress[0].hostname}"],
      { capture: true, allowFailure: true },
    );
    const hostname = stdout.trim();
    if (hostname) return hostname;
    if (Date.now() >= deadline) return null;
    await sleep(5000);
  }
}

const wildcardRecordName = (outputs) => `*.${outputs.environment_domain}.`;

async function dns(config) {
  const { outputs } = config;
  await kubeconfig(config);
  const hostname = await ingressHostname({ waitMs: 5 * 60 * 1000 });
  if (!hostname) fail("the Ingress has no load balancer hostname yet (kubectl -n learning-lab describe ingress llp-gateway)");
  const name = wildcardRecordName(outputs);
  const change = {
    Comment: "learning-lab dev gateway (scripts/deploy-dev.mjs)",
    Changes: [{ Action: "UPSERT", ResourceRecordSet: { Name: name, Type: "CNAME", TTL: 60, ResourceRecords: [{ Value: hostname }] } }],
  };
  await run("aws", ["route53", "change-resource-record-sets", "--hosted-zone-id", outputs.dns_zone_id, "--change-batch", JSON.stringify(change)], { capture: true });
  console.log(`[deploy-dev] ${name.slice(0, -1)} → ${hostname}`);
}

async function convexEnvGet(target, name) {
  const { code, stdout } = await run("npx", target.args(["convex", "env", "get", name, "--prod"]), { capture: true, allowFailure: true, env: target.env });
  return code === 0 ? stdout.trim() : "";
}

async function convex(config) {
  requireSettings(config, "convexUrl", "runnerSecret");
  const { convexUrl, runnerSecret } = config;
  const target = await convexTarget();
  const deployment = target.deployKey
    ? `the deployment of CONVEX_DEPLOY_KEY (${target.deployKey.split("|")[0]})`
    : `the prod deployment of ${(await readEnvLocalValue("CONVEX_DEPLOYMENT", new URL("../.env.local", import.meta.url))) ?? "the .env.local project"}`;
  console.log(`[deploy-dev] convex target: ${deployment}; expected ${convexUrl}`);
  // A deployment that says it is something other than dev is the wrong one.
  const before = await convexEnvGet(target, "HOSTED_ENVIRONMENT");
  if (before && before !== "dev") fail(`the Convex target has HOSTED_ENVIRONMENT=${before}, not dev; set CONVEX_DEPLOY_KEY (.env.dev, or the CI secret) to pin the dev deployment`);

  const options = { env: target.env, redact: [runnerSecret, target.deployKey] };
  await run("npx", target.args(["convex", "env", "set", "HOSTED_ENVIRONMENT", "dev", "--prod"]), options);
  // The Convex CLI only takes the value on argv; it is redacted from errors.
  await run("npx", target.args(["convex", "env", "set", "RUNNER_SHARED_SECRET", runnerSecret, "--prod"]), { ...options, capture: true });
  await run("npx", ["convex", "deploy", "--yes"], options);
  const after = await convexEnvGet(target, "HOSTED_ENVIRONMENT");
  if (after !== "dev") fail(`HOSTED_ENVIRONMENT on the Convex target reads ${JSON.stringify(after)} after the deploy, expected "dev"`);
  await run("npx", target.args(["convex", "run", "labs:seedCatalogInternal", "--prod"]), options);
  console.log(`[deploy-dev] convex deployed (${deployment}) and catalog seeded`);
}

async function scenarios() {
  await run("node", ["scripts/publish-scenarios.mjs"]);
}

async function frontend(config) {
  requireSettings(config, "convexUrl", "clerkKey");
  const { outputs, convexUrl, clerkKey } = config;
  // Explicit env wins over every .env file Vite loads (.env, .env.local,
  // .env.production[.local]); other VITE_ values in those files still apply.
  await run("npx", ["vite", "build", "--mode", "production"], {
    env: {
      VITE_CONVEX_URL: convexUrl,
      VITE_AUTH_MODE: "configured",
      VITE_CLERK_PUBLISHABLE_KEY: clerkKey,
      VITE_PRODUCT_SURFACE: "dev",
    },
  });
  const bucket = `s3://${outputs.frontend_bucket}`;
  // Hashed chunks first, cached for a year and never deleted, so a tab still
  // running the previous build can load its lazy chunks; then the shell
  // (index.html and friends) with no-cache so the next load sees this build.
  await run("aws", ["s3", "sync", "dist/assets/", `${bucket}/assets/`, "--cache-control", "public,max-age=31536000,immutable", "--region", outputs.aws_region]);
  await run("aws", ["s3", "sync", "dist/", `${bucket}/`, "--exclude", "assets/*", "--cache-control", "no-cache", "--region", outputs.aws_region]);
  await run("aws", ["cloudfront", "create-invalidation", "--distribution-id", outputs.cloudfront_distribution_id, "--paths", "/*"], { capture: true });
  console.log(`[deploy-dev] frontend published: ${outputs.app_url}`);
}

async function status(config) {
  const { outputs } = config;
  await kubeconfig(config);
  await run("kubectl", ["--context", KUBE_CONTEXT, "get", "pods", "-n", NAMESPACE, "-o", "wide"], { allowFailure: true });
  await run("kubectl", ["--context", KUBE_CONTEXT, "get", "pods", "-n", SESSIONS_NAMESPACE, "-o", "wide"], { allowFailure: true });
  await run("kubectl", ["--context", KUBE_CONTEXT, "-n", NAMESPACE, "get", "ingress"], { allowFailure: true });
  await run("kubectl", ["--context", KUBE_CONTEXT, "-n", NAMESPACE, "logs", "deployment/llp-dispatcher", "--tail=10"], { allowFailure: true });
  await run("kubectl", ["--context", KUBE_CONTEXT, "-n", NAMESPACE, "get", "cronjob,job", "-l", "app.kubernetes.io/name=llp-reaper"], { allowFailure: true });
  const hostname = await ingressHostname(config);
  if (hostname) {
    // The CloudWatch LoadBalancer dimension (app/<name>/<id>) for the gateway 5xx alarm.
    const { stdout } = await run(
      "aws",
      ["elbv2", "describe-load-balancers", "--region", outputs.aws_region, "--query", `LoadBalancers[?DNSName=='${hostname}'].LoadBalancerArn`, "--output", "text"],
      { capture: true, allowFailure: true },
    );
    const arn = stdout.trim();
    const suffix = arn.includes(":loadbalancer/") ? arn.slice(arn.indexOf(":loadbalancer/") + ":loadbalancer/".length) : null;
    if (suffix) console.log(`[deploy-dev] gateway ALB ${suffix} (set gateway_alb_arn_suffix in dev.tfvars for the 5xx alarm)`);
  }
  console.log(`[deploy-dev] app ${outputs.app_url}; sessions *.${outputs.environment_domain}`);
}

async function waitFor(description, check, { timeoutMs, intervalMs = 10_000 }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    console.log(`[deploy-dev] waiting for ${description}…`);
    await sleep(intervalMs);
  }
}

/**
 * Removes what Terraform does not own so `infra:dev:destroy` can finish: the
 * ALB and its security groups (created by the Ingress; they would block the
 * VPC, subnet and certificate deletes) and the *.dev CNAME (Terraform cannot
 * delete a zone that still has it).
 */
async function teardown(config) {
  const { outputs } = config;
  await kubeconfig(config);
  const uninstall = await run("helm", ["uninstall", RELEASE, "--kube-context", KUBE_CONTEXT, "--namespace", NAMESPACE, "--wait", "--timeout", "300s"], {
    capture: true,
    allowFailure: true,
  });
  if (uninstall.code !== 0 && !/not found/i.test(uninstall.stderr)) fail(`helm uninstall failed:\n${uninstall.stderr}`);
  console.log(`[deploy-dev] ${uninstall.code === 0 ? "release uninstalled" : "release was not installed"}`);

  // The Ingress keeps a finalizer until the load balancer controller has
  // deleted the ALB, so its disappearance is the first signal.
  const ingressGone = await waitFor(
    "the gateway Ingress to be deleted",
    async () => {
      const { code, stderr } = await run("kubectl", ["--context", KUBE_CONTEXT, "-n", NAMESPACE, "get", "ingress", "llp-gateway"], { capture: true, allowFailure: true });
      return code !== 0 && /NotFound|not found/.test(stderr);
    },
    { timeoutMs: 10 * 60 * 1000 },
  );
  if (!ingressGone) fail("the llp-gateway Ingress still exists after 10 min (kubectl -n learning-lab describe ingress llp-gateway)");

  // Then the ALB itself, in this VPC (the load balancer controller names them k8s-…).
  const albsGone = await waitFor(
    "the gateway load balancer to be deleted",
    async () => {
      const { stdout } = await run(
        "aws",
        ["elbv2", "describe-load-balancers", "--region", outputs.aws_region, "--query", "LoadBalancers[?starts_with(LoadBalancerName, 'k8s-')].[LoadBalancerName,VpcId]", "--output", "json"],
        { capture: true },
      );
      const remaining = JSON.parse(stdout || "[]").filter(([, vpcId]) => !outputs.vpc_id || vpcId === outputs.vpc_id);
      return remaining.length === 0;
    },
    { timeoutMs: 5 * 60 * 1000 },
  );
  if (!albsGone) fail("a k8s-* load balancer is still present after 5 min; delete it in the EC2 console before destroying");

  // Route 53 deletes need the record exactly as it is.
  const name = wildcardRecordName(outputs);
  const { stdout } = await run(
    "aws",
    ["route53", "list-resource-record-sets", "--hosted-zone-id", outputs.dns_zone_id, "--start-record-name", name, "--start-record-type", "CNAME", "--max-items", "1", "--output", "json"],
    { capture: true },
  );
  const record = JSON.parse(stdout).ResourceRecordSets?.[0];
  const normalized = record?.Name?.replace(/^\\052/, "*");
  if (record && normalized === name && record.Type === "CNAME") {
    const change = { Comment: "learning-lab dev teardown (scripts/deploy-dev.mjs)", Changes: [{ Action: "DELETE", ResourceRecordSet: record }] };
    await run("aws", ["route53", "change-resource-record-sets", "--hosted-zone-id", outputs.dns_zone_id, "--change-batch", JSON.stringify(change)], { capture: true });
    console.log(`[deploy-dev] deleted ${name.slice(0, -1)} CNAME`);
  } else {
    console.log(`[deploy-dev] no ${name.slice(0, -1)} CNAME to delete`);
  }
  console.log("[deploy-dev] cluster workloads removed; now run: npm run infra:dev:destroy");
}

const COMMANDS = { images, convex, chart, dns, scenarios, frontend, status, teardown };

async function main(argv) {
  const command = argv[0] ?? "all";
  if (command !== "all" && !COMMANDS[command]) fail(`unknown command ${command} (all|${Object.keys(COMMANDS).join("|")})`);
  const config = await settings();
  if (command !== "all") return COMMANDS[command](config);
  // Convex first: the deployment holds the runner secret the pods will use
  // and the catalog the scenario approvals are keyed by.
  requireSettings(config, "convexUrl", "runnerSecret", "clerkKey");
  await images(config);
  await convex(config);
  await chart(config);
  await dns(config);
  await scenarios(config);
  await frontend(config);
  console.log(`[deploy-dev] done: ${config.outputs.app_url}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message ?? error);
    process.exitCode = 1;
  }
}
