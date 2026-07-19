locals {
  common_tags = {
    Environment   = "staging"
    ManagedBy     = "terraform"
    Module        = "hosted-runner"
    ModuleVersion = "1.0.0"
    Project       = "learning-lab-platform"
    Root          = "staging"
  }
}

data "aws_sns_topic" "security_alerts" {
  name = "learning-lab-platform-security-alerts"
}

module "hosted_runner" {
  source = "../../modules/hosted-runner"

  aws_region                       = var.aws_region
  checkpoint_retention_days        = 2
  deletion_protection              = true
  ecr_force_delete                 = false
  egress_proxy_image_uri           = var.egress_proxy_image_uri
  enable_nat_gateway               = var.enable_nat_gateway
  enable_egress_proxy              = true
  enable_learner_metadata_boundary = true
  enable_service_secret_boundary   = true
  enable_security_observability    = true
  enable_public_alb                = true
  environment                      = "staging"
  log_retention_days               = 14
  alb_access_log_retention_days    = 90
  module_contract_version          = "1.0.0"
  project_name                     = "learning-lab-platform"
  public_hostname                  = var.public_hostname
  route53_zone_id                  = var.route53_zone_id
  runner_cpu                       = var.runner_cpu
  runner_cpu_architecture          = "ARM64"
  runner_ephemeral_storage_gib     = var.runner_ephemeral_storage_gib
  runner_image_uri                 = var.runner_image_uri
  runner_memory                    = var.runner_memory
  security_alarm_topic_arn         = data.aws_sns_topic.security_alerts.arn
  ttl_cleanup_schedule             = "rate(1 minute)"
  ttl_max_managed_runtime_seconds  = 28800
  vpc_cidr                         = var.vpc_cidr
}
