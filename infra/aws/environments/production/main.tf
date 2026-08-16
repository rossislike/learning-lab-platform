locals {
  alarm_lifecycle = jsondecode(file("${path.root}/../../account-security/zz-learning-lab-alarms.auto.tfvars.json"))
  common_tags = {
    Environment   = "production"
    ManagedBy     = "terraform"
    Module        = "hosted-runner"
    ModuleVersion = "1.0.0"
    Project       = "learning-lab-platform"
    Root          = "production"
  }
  staging_ecr_repository_arns = [
    for suffix in ["runner", "dispatcher", "session-gateway", "egress-proxy"] :
    "arn:${data.aws_partition.current.partition}:ecr:${var.aws_region}:${var.expected_aws_account_id}:repository/learning-lab-platform-staging-${suffix}"
  ]
}

resource "terraform_data" "alarm_lifecycle_guard" {
  input = try(local.alarm_lifecycle.enable_learning_lab_alarms, false)

  lifecycle {
    precondition {
      condition = (
        length(keys(local.alarm_lifecycle)) == 1 &&
        try(local.alarm_lifecycle.enable_learning_lab_alarms == true, false)
      )
      error_message = "Hosted infrastructure requires the guarded workflow to enable the shared learning-lab alarms first."
    }
  }
}

data "aws_partition" "current" {}

data "aws_sns_topic" "security_alerts" {
  name = "learning-lab-platform-security-alerts"
}

data "aws_iam_openid_connect_provider" "github_actions" {
  url = "https://token.actions.githubusercontent.com"
}

module "hosted_runner" {
  source = "../../modules/hosted-runner"

  aws_region                       = var.aws_region
  checkpoint_retention_days        = 7
  deletion_protection              = true
  ecr_force_delete                 = false
  egress_proxy_image_uri           = var.egress_proxy_image_uri
  enable_nat_gateway               = var.enable_nat_gateway
  enable_egress_proxy              = true
  enable_learner_metadata_boundary = true
  enable_service_secret_boundary   = true
  enable_security_observability    = true
  enable_public_alb                = true
  environment                      = "production"
  log_retention_days               = 30
  alb_access_log_retention_days    = 365
  module_contract_version          = "1.0.0"
  project_name                     = "learning-lab-platform"
  public_hostname                  = var.public_hostname
  route53_zone_id                  = var.route53_zone_id
  runner_cpu                       = var.runner_cpu
  runner_cpu_architecture          = "ARM64"
  runner_ephemeral_storage_gib     = var.runner_ephemeral_storage_gib
  runner_image_uri                 = var.runner_image_uri
  runner_image_kind                = var.runner_image_kind
  runner_memory                    = var.runner_memory
  security_alarm_topic_arn         = data.aws_sns_topic.security_alerts.arn
  ttl_cleanup_schedule             = "rate(1 minute)"
  ttl_max_managed_runtime_seconds  = 28800
  vpc_cidr                         = var.vpc_cidr
}

module "github_image_delivery" {
  source = "../../modules/github-image-delivery"

  environment                          = "production"
  github_oidc_provider_arn             = data.aws_iam_openid_connect_provider.github_actions.arn
  github_repository                    = var.github_repository
  promotion_source_ecr_repository_arns = local.staging_ecr_repository_arns
  ecr_repository_arns = [
    module.hosted_runner.runner_ecr_repository_arn,
    module.hosted_runner.dispatcher_ecr_repository_arn,
    module.hosted_runner.gateway_ecr_repository_arn,
    module.hosted_runner.egress_proxy_repository_arn,
  ]
}
