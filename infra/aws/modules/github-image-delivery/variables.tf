variable "environment" {
  description = "Hosted environment allowed to publish images."
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}

variable "github_repository" {
  description = "GitHub repository in owner/name form."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "github_repository must use owner/name form."
  }
}

variable "ecr_repository_arns" {
  description = "ECR repositories the delivery role may publish to."
  type        = list(string)

  validation {
    condition     = length(var.ecr_repository_arns) > 0 && alltrue([for arn in var.ecr_repository_arns : can(regex(":ecr:[^:]+:[0-9]{12}:repository/", arn))])
    error_message = "ecr_repository_arns must contain ECR repository ARNs."
  }
}

variable "promotion_source_ecr_repository_arns" {
  description = "Staging ECR repositories the production delivery role may read during exact-digest promotion."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for arn in var.promotion_source_ecr_repository_arns : can(regex(":ecr:[^:]+:[0-9]{12}:repository/", arn))])
    error_message = "promotion_source_ecr_repository_arns must contain ECR repository ARNs."
  }
}

variable "github_oidc_provider_arn" {
  description = "Account-level GitHub Actions OIDC provider ARN."
  type        = string

  validation {
    condition     = can(regex("^arn:[^:]+:iam::[0-9]{12}:oidc-provider/token\\.actions\\.githubusercontent\\.com$", var.github_oidc_provider_arn))
    error_message = "github_oidc_provider_arn must identify the GitHub Actions OIDC provider."
  }
}
