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
  alert_email                  = var.alert_email
  daily_cost_budget_usd        = var.daily_cost_budget_usd
  gateway_alb_arn_suffix       = var.gateway_alb_arn_suffix

  cluster_endpoint_public_access_cidrs = var.cluster_endpoint_public_access_cidrs
}

# CI: the GitHub Actions deploy role (push to main → npm run deploy:dev).
module "github_deploy" {
  source = "../../modules/github-deploy"

  name                        = local.name
  github_repository           = var.github_repository
  github_sub_claim_prefix     = var.github_sub_claim_prefix
  ecr_repository_arns         = module.platform.ecr_repository_arns
  terraform_state_bucket      = var.terraform_state_bucket
  terraform_state_key         = var.terraform_state_key
  terraform_state_kms_key_arn = var.terraform_state_kms_key_arn
  bundles_bucket_arn          = module.platform.bundles_bucket_arn
  frontend_bucket_arn         = module.platform.frontend_bucket_arn
  cloudfront_distribution_arn = module.platform.cloudfront_distribution_arn
  dns_zone_id                 = module.platform.dns_zone_id
  cluster_arn                 = module.platform.cluster_arn
}

# helm/kubectl from the workflow: cluster-admin on the dev cluster.
resource "aws_eks_access_entry" "github_deploy" {
  cluster_name  = module.platform.cluster_name
  principal_arn = module.github_deploy.role_arn
  type          = "STANDARD"
}

resource "aws_eks_access_policy_association" "github_deploy" {
  cluster_name  = module.platform.cluster_name
  principal_arn = module.github_deploy.role_arn
  policy_arn    = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy"

  access_scope {
    type = "cluster"
  }

  depends_on = [aws_eks_access_entry.github_deploy]
}
