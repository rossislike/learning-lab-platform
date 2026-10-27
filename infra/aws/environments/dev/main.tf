# The single hosted environment (ADR 0007). Deletion protection is off on
# purpose: this environment is rebuilt rather than preserved.

data "aws_caller_identity" "current" {}

locals {
  name = "learning-lab-dev"
  common_tags = {
    Environment = "dev"
    ManagedBy   = "terraform"
    Project     = "learning-lab-platform"
    Root        = "environments/dev"
  }
}

check "expected_account" {
  assert {
    condition     = data.aws_caller_identity.current.account_id == var.expected_aws_account_id
    error_message = "The active AWS account does not match expected_aws_account_id."
  }
}

module "platform" {
  source = "../../modules/eks-platform"

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  name                         = local.name
  environment                  = "dev"
  aws_region                   = var.aws_region
  parent_domain                = var.parent_domain
  dns_zone_name                = var.dns_zone_name
  create_dns_zone              = var.create_dns_zone
  kubernetes_version           = var.kubernetes_version
  cluster_admin_principal_arns = var.cluster_admin_principal_arns

  cluster_endpoint_public_access_cidrs = var.cluster_endpoint_public_access_cidrs
}
