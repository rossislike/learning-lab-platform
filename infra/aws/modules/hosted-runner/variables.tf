variable "aws_region" {
  description = "AWS region for hosted runner resources."
  type        = string
  default     = "us-east-2"
}

variable "module_contract_version" {
  description = "Compatibility contract implemented by this hosted-runner module source. This is not the immutable source version."
  type        = string
  default     = "1.0.0"

  validation {
    condition     = var.module_contract_version == "1.0.0"
    error_message = "This source tree implements hosted-runner module contract 1.0.0."
  }
}

variable "project_name" {
  description = "Prefix for resource names and tags."
  type        = string
  default     = "learning-lab-platform"
}

variable "environment" {
  description = "Deployment environment name."
  type        = string
  default     = "validation"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{0,15}$", var.environment))
    error_message = "environment must be 1 through 16 lowercase letters, digits, or hyphens, and must start with a letter or digit."
  }
}

variable "vpc_cidr" {
  description = "CIDR for the hosted runner VPC."
  type        = string
  default     = "10.42.0.0/16"
}

variable "enable_nat_gateway" {
  description = "Create a NAT gateway so private session tasks can reach Convex and package registries."
  type        = bool
  default     = true
}

variable "runner_image_uri" {
  description = "Immutable image URI used by the hosted runner task definition."
  type        = string

  validation {
    condition = (
      !contains(["staging", "production"], var.environment) ||
      can(regex("@sha256:[0-9a-f]{64}$", var.runner_image_uri))
    )
    error_message = "Staging and production runner_image_uri values must be pinned by sha256 digest."
  }
}

variable "deletion_protection" {
  description = "Require non-destructive data-resource settings for persistent environments."
  type        = bool
  default     = false

  validation {
    condition     = !contains(["staging", "production"], var.environment) || var.deletion_protection
    error_message = "Staging and production require deletion_protection=true."
  }
}

variable "ecr_force_delete" {
  description = "Allow Terraform to delete the runner ECR repository while it contains images. Use only for disposable validation environments."
  type        = bool
  default     = false
}

variable "runner_cpu" {
  description = "Fargate task CPU units."
  type        = number
  default     = 1024
}

variable "runner_memory" {
  description = "Fargate task memory in MiB."
  type        = number
  default     = 2048
}

variable "runner_ephemeral_storage_gib" {
  description = "Fargate ephemeral storage. AWS accepts explicit values from 21 through 200 GiB."
  type        = number
  default     = 21

  validation {
    condition     = var.runner_ephemeral_storage_gib >= 21 && var.runner_ephemeral_storage_gib <= 200
    error_message = "runner_ephemeral_storage_gib must be between 21 and 200."
  }
}

variable "runner_cpu_architecture" {
  description = "Fargate runner CPU architecture."
  type        = string
  default     = "ARM64"

  validation {
    condition     = contains(["ARM64", "X86_64"], var.runner_cpu_architecture)
    error_message = "runner_cpu_architecture must be ARM64 or X86_64."
  }
}

variable "checkpoint_retention_days" {
  description = "Defense-in-depth maximum retention for session checkpoints."
  type        = number
  default     = 7
}

variable "log_retention_days" {
  description = "CloudWatch log retention."
  type        = number
  default     = 14
}

variable "ttl_cleanup_schedule" {
  description = "EventBridge expression for the independent ECS TTL reaper."
  type        = string
  default     = "rate(1 minute)"
}

variable "ttl_max_managed_runtime_seconds" {
  description = "Fail-safe lifetime for managed tasks whose expiry tag is missing or malformed."
  type        = number
  default     = 28800

  validation {
    condition     = var.ttl_max_managed_runtime_seconds >= 300
    error_message = "ttl_max_managed_runtime_seconds must be at least 300."
  }
}
