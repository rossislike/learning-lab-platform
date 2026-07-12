locals {
  isolation_registry = jsondecode(file("${path.root}/../../../../config/hosted-environments.json"))
  isolation_identities = [
    for environment in ["development", "staging", "production"] :
    local.isolation_registry.environments[environment]
  ]
  aws_account_sharing_allowed = local.isolation_registry.temporaryException.approved == true && anytrue([
    for rule in local.isolation_registry.temporaryException.allowedIdentitySharing :
    rule.field == "awsAccountId" && toset(rule.environments) == toset(["staging", "production"])
  ]) && timecmp(timestamp(), "${local.isolation_registry.temporaryException.deadline}T23:59:59Z") <= 0
  isolation_exception_valid = local.isolation_registry.temporaryException.productionLearnerTrafficBlocked == true && alltrue([
    for rule in local.isolation_registry.temporaryException.allowedIdentitySharing :
    toset(rule.environments) == toset(["staging", "production"])
    ]) && (
    local.isolation_registry.temporaryException.approved == true ||
    length(local.isolation_registry.temporaryException.allowedIdentitySharing) == 0
    ) && (
    length(local.isolation_registry.temporaryException.allowedIdentitySharing) == 0 ||
    timecmp(timestamp(), "${local.isolation_registry.temporaryException.deadline}T23:59:59Z") <= 0
  )
  isolation_registry_ready = local.isolation_exception_valid && alltrue([
    for identity in slice(local.isolation_identities, 1, 3) : identity.awsAccountId != null
    ]) && (
    length(distinct(compact([for identity in local.isolation_identities : identity.awsAccountId]))) == 2 ||
    (
      local.aws_account_sharing_allowed
    )
  )
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
