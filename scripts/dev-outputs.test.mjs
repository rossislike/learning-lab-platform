import assert from "node:assert/strict";
import test from "node:test";
import { parseTerraformOutputs } from "./dev-outputs.mjs";

const full = {
  cluster_name: { value: "learning-lab-dev" },
  aws_region: { value: "us-east-2" },
  ecr_repository_urls: { value: { platform: "4.dkr.ecr.us-east-2.amazonaws.com/learning-lab/platform", "session-workspace": "4.dkr.ecr.us-east-2.amazonaws.com/learning-lab/session-workspace" } },
  bundles_bucket: { value: "learning-lab-dev-bundles-4-us-east-2" },
  frontend_bucket: { value: "learning-lab-dev-frontend-4-us-east-2" },
  cloudfront_distribution_id: { value: "E123" },
  app_url: { value: "https://app.dev.example.com" },
  environment_domain: { value: "dev.example.com" },
  alb_certificate_arn: { value: "arn:aws:acm:us-east-2:4:certificate/x" },
  dns_zone_id: { value: "Z1" },
  cluster_dns_ip: { value: "172.20.0.10" },
  name_servers: { value: null },
};

test("parseTerraformOutputs flattens values and keeps optional nulls", () => {
  const outputs = parseTerraformOutputs(JSON.stringify(full));
  assert.equal(outputs.cluster_name, "learning-lab-dev");
  assert.equal(outputs.ecr_repository_urls.platform, "4.dkr.ecr.us-east-2.amazonaws.com/learning-lab/platform");
  assert.equal(outputs.name_servers, null);
  assert.equal(outputs.cluster_dns_ip, "172.20.0.10");
});

test("parseTerraformOutputs names what is missing", () => {
  const { app_url, dns_zone_id, cluster_dns_ip, ...partial } = full;
  void app_url;
  void dns_zone_id;
  void cluster_dns_ip;
  assert.throws(() => parseTerraformOutputs(JSON.stringify(partial)), /missing: app_url, dns_zone_id, cluster_dns_ip/);
  assert.throws(() => parseTerraformOutputs("{}"), /infra:dev:apply/);
});
