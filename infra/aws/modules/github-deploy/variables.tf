variable "name" {
  description = "Environment name prefix (matches the eks-platform module)."
  type        = string
  default     = "learning-lab-dev"
}

variable "github_repository" {
  description = "GitHub repository in owner/name form whose `dev` environment deploys."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "github_repository must use owner/name form."
  }
}

variable "github_environment" {
  description = "GitHub Actions environment the deploy job runs in; the only trusted OIDC subject. Restrict its deployment branches to main."
  type        = string
  default     = "dev"
}

variable "ecr_repository_arns" {
  description = "ECR repositories the workflow pushes to."
  type        = list(string)

  validation {
    condition     = length(var.ecr_repository_arns) > 0 && alltrue([for arn in var.ecr_repository_arns : can(regex(":ecr:[^:]+:[0-9]{12}:repository/", arn))])
    error_message = "ecr_repository_arns must contain ECR repository ARNs."
  }
}

variable "terraform_state_bucket" {
  description = "State bucket the workflow reads outputs from (config/aws-terraform-backends.json)."
  type        = string
}

variable "terraform_state_key" {
  description = "State object key of the dev root."
  type        = string
}

variable "terraform_state_kms_key_arn" {
  description = "KMS key that encrypts the state bucket."
  type        = string
}

variable "bundles_bucket_arn" {
  type = string
}

variable "frontend_bucket_arn" {
  type = string
}

variable "cloudfront_distribution_arn" {
  type = string
}

variable "dns_zone_id" {
  type = string
}

variable "cluster_arn" {
  type = string
}

variable "github_sub_claim_prefix" {
  description = "The repository's OIDC subject prefix as GitHub reports it (`gh api repos/<owner>/<repo>/actions/oidc/customization/sub` → sub_claim_prefix). Repositories with immutable subjects send `repo:<owner>@<id>/<repo>@<id>`; null means the plain `repo:<owner>/<repo>` form."
  type        = string
  default     = null
}
