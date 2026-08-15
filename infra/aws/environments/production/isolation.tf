locals {
  isolation_registry = jsondecode(file("${path.root}/../../../../config/hosted-environments.json"))
  account_topology   = local.isolation_registry.awsAccountTopology
  staging_account    = local.isolation_registry.environments.staging.awsAccountId
  production_account = local.isolation_registry.environments.production.awsAccountId
  isolation_boundaries = toset([
    "terraformState",
    "resourceNames",
    "network",
    "iam",
    "kms",
    "ecr",
    "objectStorage",
    "secrets",
  ])
  isolation_registry_ready = (
    local.isolation_registry.schemaVersion == 2 &&
    toset(local.account_topology.environments) == toset(["staging", "production"]) &&
    toset(local.account_topology.isolationBoundaries) == local.isolation_boundaries &&
    local.account_topology.mode == "shared" &&
    local.account_topology.sharedAccountId == "442359104502" &&
    local.staging_account != null &&
    local.production_account != null &&
    local.staging_account == local.account_topology.sharedAccountId &&
    local.production_account == local.account_topology.sharedAccountId
  )
}

resource "terraform_data" "environment_isolation_guard" {
  input = local.isolation_registry.environments.production

  lifecycle {
    precondition {
      condition     = local.isolation_registry_ready
      error_message = "Hosted AWS account topology is incomplete or inconsistent with config/hosted-environments.json."
    }
    precondition {
      condition     = local.isolation_registry.environments.production.awsAccountId == var.expected_aws_account_id
      error_message = "expected_aws_account_id must match the production account in config/hosted-environments.json."
    }
  }
}
