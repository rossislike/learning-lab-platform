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

module "hosted_runner" {
  source = "../../modules/hosted-runner"

  aws_region                      = var.aws_region
  checkpoint_retention_days       = 2
  deletion_protection             = true
  ecr_force_delete                = false
  enable_nat_gateway              = var.enable_nat_gateway
  environment                     = "staging"
  log_retention_days              = 14
  module_contract_version         = "1.0.0"
  project_name                    = "learning-lab-platform"
  runner_cpu                      = var.runner_cpu
  runner_cpu_architecture         = "ARM64"
  runner_ephemeral_storage_gib    = var.runner_ephemeral_storage_gib
  runner_image_uri                = var.runner_image_uri
  runner_memory                   = var.runner_memory
  ttl_cleanup_schedule            = "rate(1 minute)"
  ttl_max_managed_runtime_seconds = 28800
  vpc_cidr                        = var.vpc_cidr
}
