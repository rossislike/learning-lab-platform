variable "aws_region" {
  type    = string
  default = "us-east-2"
}

variable "expected_aws_account_id" {
  description = "Twelve-digit production AWS account ID."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.expected_aws_account_id))
    error_message = "expected_aws_account_id must be a twelve-digit AWS account ID."
  }
}

variable "runner_image_uri" {
  description = "Approved production runner image pinned by digest."
  type        = string

  validation {
    condition = can(regex(
      "^${var.expected_aws_account_id}\\.dkr\\.ecr\\.${var.aws_region}\\.amazonaws\\.com/learning-lab-platform-production-runner@sha256:[0-9a-f]{64}$",
      var.runner_image_uri,
    ))
    error_message = "runner_image_uri must be the production runner repository in expected_aws_account_id and aws_region, pinned by sha256 digest."
  }
}

variable "runner_image_kind" {
  description = "Runtime contract for the promoted runner image."
  type        = string
  default     = "validation"

  validation {
    condition     = contains(["validation", "learner-session"], var.runner_image_kind)
    error_message = "runner_image_kind must be validation or learner-session."
  }
}

variable "egress_proxy_image_uri" {
  description = "Approved production egress proxy image pinned by digest."
  type        = string

  validation {
    condition = can(regex(
      "^${var.expected_aws_account_id}\\.dkr\\.ecr\\.${var.aws_region}\\.amazonaws\\.com/learning-lab-platform-production-egress-proxy@sha256:[0-9a-f]{64}$",
      var.egress_proxy_image_uri,
    ))
    error_message = "egress_proxy_image_uri must be the production proxy repository in expected_aws_account_id and aws_region, pinned by sha256 digest."
  }
}

variable "vpc_cidr" {
  type    = string
  default = "10.62.0.0/16"
}

variable "enable_nat_gateway" {
  type    = bool
  default = true
}

variable "public_hostname" {
  description = "Production hostname served by the public ALB."
  type        = string
}

variable "route53_zone_id" {
  description = "Public Route 53 hosted zone ID that owns public_hostname."
  type        = string
}

variable "runner_cpu" {
  type    = number
  default = 1024
}

variable "runner_memory" {
  type    = number
  default = 2048
}

variable "runner_ephemeral_storage_gib" {
  type    = number
  default = 21
}
