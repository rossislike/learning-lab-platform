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

  aws_region                      = var.aws_region
  checkpoint_retention_days       = var.checkpoint_retention_days
  deletion_protection             = var.deletion_protection
  ecr_force_delete                = var.ecr_force_delete
  enable_nat_gateway              = var.enable_nat_gateway
  environment                     = var.environment
  log_retention_days              = var.log_retention_days
  module_contract_version         = var.module_contract_version
  project_name                    = var.project_name
  runner_cpu                      = var.runner_cpu
  runner_cpu_architecture         = var.runner_cpu_architecture
  runner_ephemeral_storage_gib    = var.runner_ephemeral_storage_gib
  runner_image_uri                = var.runner_image_uri
  runner_memory                   = var.runner_memory
  ttl_cleanup_schedule            = var.ttl_cleanup_schedule
  ttl_max_managed_runtime_seconds = var.ttl_max_managed_runtime_seconds
  vpc_cidr                        = var.vpc_cidr
}
