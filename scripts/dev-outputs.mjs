// Reads `terraform output -json` from infra/aws/environments/dev. Every dev
// script takes its bucket names, cluster name and domains from here, so the
// Terraform root is the only place they are written down.

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { projectRoot } from "./scenario-catalog.mjs";

export const devRoot = resolve(projectRoot, "infra/aws/environments/dev");

const REQUIRED = [
  "cluster_name",
  "aws_region",
  "ecr_repository_urls",
  "bundles_bucket",
  "frontend_bucket",
  "cloudfront_distribution_id",
  "app_url",
  "environment_domain",
  "alb_certificate_arn",
  "dns_zone_id",
  "cluster_dns_ip",
];

/** Flattens the `{ name: { value } }` shape Terraform prints. */
export function parseTerraformOutputs(json) {
  const parsed = JSON.parse(json);
  const outputs = Object.fromEntries(Object.entries(parsed).map(([name, entry]) => [name, entry?.value]));
  const missing = REQUIRED.filter((name) => outputs[name] === undefined || outputs[name] === null || outputs[name] === "");
  if (missing.length > 0) throw new Error(`terraform outputs missing: ${missing.join(", ")} (run npm run infra:dev:apply first)`);
  return outputs;
}

export function readDevOutputs({ cwd = devRoot } = {}) {
  return new Promise((resolveOutputs, reject) => {
    const child = spawn("terraform", ["output", "-json"], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => reject(new Error(`terraform: ${error.message}`)));
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`terraform output failed in ${cwd}:\n${stderr.trim()}`));
      try {
        resolveOutputs(parseTerraformOutputs(stdout));
      } catch (error) {
        reject(error);
      }
    });
  });
}
