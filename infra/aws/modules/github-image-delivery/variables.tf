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

variable "create_production_promotion_reader" {
  description = "Create a read-only role for production promotion jobs to pull staging digests."
  type        = bool
  default     = false
}

variable "github_oidc_thumbprints" {
  description = "TLS certificate thumbprints for token.actions.githubusercontent.com."
  type        = list(string)
  default     = ["6938fd4d98bab03faadb97b34396831e3780aea1"]

  validation {
    condition     = length(var.github_oidc_thumbprints) > 0 && alltrue([for value in var.github_oidc_thumbprints : can(regex("^[0-9a-f]{40}$", value))])
    error_message = "github_oidc_thumbprints must contain lowercase SHA1 thumbprints."
  }
}
