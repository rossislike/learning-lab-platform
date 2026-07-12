locals {
  isolation_registry = jsondecode(file("${path.root}/../../../../config/hosted-environments.json"))
  isolation_identities = [
    for environment in ["development", "staging", "production"] :
    local.isolation_registry.environments[environment]
  ]
  isolation_registry_ready = alltrue(flatten([
    for identity in local.isolation_identities : [
      identity.awsAccountId != null || identity == local.isolation_identities[0],
      identity.clerkApplicationId != null,
      identity.convexDeployment != null,
    ]
  ])) && length(distinct(compact([for identity in local.isolation_identities : identity.awsAccountId]))) == 2 && length(distinct([for identity in local.isolation_identities : identity.clerkApplicationId])) == 3 && length(distinct([for identity in local.isolation_identities : identity.convexDeployment])) == 3
}

resource "terraform_data" "environment_isolation_guard" {
  input = local.isolation_registry.environments.production

  lifecycle {
    precondition {
      condition     = local.isolation_registry_ready
      error_message = "Hosted environment identities are incomplete or shared. Update config/hosted-environments.json and run npm run env:isolation:require-ready."
    }
    precondition {
      condition     = local.isolation_registry.environments.production.awsAccountId == var.expected_aws_account_id
      error_message = "expected_aws_account_id must match the production account in config/hosted-environments.json."
    }
  }
}
