locals {
  common_tags = {
    Environment   = var.environment
    ManagedBy     = "terraform"
    Module        = "hosted-runner"
    ModuleVersion = var.module_contract_version
    Project       = var.project_name
    Root          = "validation"
  }
}

module "hosted_runner" {
  source = "../modules/hosted-runner"

  aws_region                       = var.aws_region
  checkpoint_retention_days        = var.checkpoint_retention_days
  deletion_protection              = var.deletion_protection
  ecr_force_delete                 = var.ecr_force_delete
  egress_proxy_image_uri           = var.egress_proxy_image_uri
  enable_nat_gateway               = var.enable_nat_gateway
  enable_egress_proxy              = var.enable_egress_proxy
  enable_learner_metadata_boundary = false
  enable_service_secret_boundary   = false
  enable_public_alb                = var.enable_public_alb
  environment                      = var.environment
  log_retention_days               = var.log_retention_days
  module_contract_version          = var.module_contract_version
  project_name                     = var.project_name
  public_hostname                  = var.public_hostname
  route53_zone_id                  = var.route53_zone_id
  runner_cpu                       = var.runner_cpu
  runner_cpu_architecture          = var.runner_cpu_architecture
  runner_ephemeral_storage_gib     = var.runner_ephemeral_storage_gib
  runner_image_uri                 = var.runner_image_uri
  runner_memory                    = var.runner_memory
  ttl_cleanup_schedule             = var.ttl_cleanup_schedule
  ttl_max_managed_runtime_seconds  = var.ttl_max_managed_runtime_seconds
  vpc_cidr                         = var.vpc_cidr
}
