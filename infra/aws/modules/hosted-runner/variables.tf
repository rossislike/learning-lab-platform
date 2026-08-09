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

variable "alb_ingress_cidrs" {
  description = "IPv4 CIDRs allowed to reach the future public ALB on HTTPS."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "enable_public_alb" {
  description = "Create the public HTTPS ALB and DNS records for this environment."
  type        = bool
  default     = false
}

variable "public_hostname" {
  description = "Environment hostname served by the public ALB."
  type        = string
  default     = ""

  validation {
    condition = (
      !var.enable_public_alb ||
      (
        length(var.public_hostname) <= 251 &&
        can(regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$", var.public_hostname))
      )
    )
    error_message = "Enabled public_hostname must be a valid lowercase DNS hostname no longer than 251 characters so its wildcard name remains within the DNS limit."
  }
}

variable "route53_zone_id" {
  description = "Public Route 53 hosted zone ID that owns public_hostname."
  type        = string
  default     = ""

  validation {
    condition     = !var.enable_public_alb || can(regex("^Z[A-Z0-9]+$", var.route53_zone_id))
    error_message = "Enabled route53_zone_id must be a Route 53 hosted zone ID."
  }
}

variable "gateway_port" {
  description = "Internal port used by the future session gateway service."
  type        = number
  default     = 8080
}

variable "egress_proxy_port" {
  description = "Internal port reserved for the controlled outbound proxy."
  type        = number
  default     = 3128
}

variable "enable_egress_proxy" {
  description = "Run the managed allowlisting HTTPS proxy service."
  type        = bool
  default     = false
}

variable "egress_proxy_image_uri" {
  description = "Immutable image URI for the allowlisting egress proxy."
  type        = string
  default     = ""

  validation {
    condition = (
      !var.enable_egress_proxy ||
      can(regex("@sha256:[0-9a-f]{64}$", var.egress_proxy_image_uri))
    )
    error_message = "Enabled egress_proxy_image_uri values must be pinned by sha256 digest."
  }
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

variable "runner_image_kind" {
  description = "Runtime contract provided by runner_image_uri. Learner-session images receive service ports and health checks."
  type        = string
  default     = "validation"

  validation {
    condition     = contains(["validation", "learner-session"], var.runner_image_kind)
    error_message = "runner_image_kind must be validation or learner-session."
  }
}

variable "runner_command" {
  description = "Optional command override started after the metadata-sanitizing entrypoint. Defaults from runner_image_kind."
  type        = list(string)
  default     = null
  nullable    = true

  validation {
    condition     = var.runner_command == null || (length(var.runner_command) > 0 && alltrue([for part in var.runner_command : length(trimspace(part)) > 0]))
    error_message = "runner_command must contain at least one non-empty argument."
  }
}

variable "enable_learner_metadata_boundary" {
  description = "Remove task IAM credentials and metadata endpoint variables from the learner container. Enable only after qualification in the target environment."
  type        = bool
  default     = false
}

variable "enable_service_secret_boundary" {
  description = "Create the dispatcher service secret and separate startup and runtime IAM roles. Secret values remain outside Terraform state."
  type        = bool
  default     = false
}

variable "enable_security_observability" {
  description = "Enable WAF, ALB access logging, and environment security alarms for the public endpoint."
  type        = bool
  default     = false

  validation {
    condition     = !var.enable_security_observability || (var.enable_public_alb && var.deletion_protection)
    error_message = "Security observability requires an enabled public ALB and deletion protection."
  }
}

variable "alb_access_log_retention_days" {
  description = "Retention period for public ALB access logs."
  type        = number
  default     = 90

  validation {
    condition     = var.alb_access_log_retention_days >= 30
    error_message = "ALB access logs must be retained for at least 30 days."
  }
}

variable "security_alarm_topic_arn" {
  description = "SNS topic ARN that receives environment security alarm notifications."
  type        = string
  default     = ""

  validation {
    condition = (
      !var.enable_security_observability ||
      can(regex("^arn:[a-z0-9-]+:sns:[a-z0-9-]+:[0-9]{12}:[A-Za-z0-9_-]+$", var.security_alarm_topic_arn))
    )
    error_message = "Security observability requires a valid SNS topic ARN."
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
