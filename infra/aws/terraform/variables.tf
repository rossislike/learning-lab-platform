variable "aws_region" {
  type    = string
  default = "us-east-2"
}

variable "module_contract_version" {
  type    = string
  default = "1.0.0"
}

variable "project_name" {
  type    = string
  default = "learning-lab-platform"
}

variable "environment" {
  type    = string
  default = "validation"
}

variable "vpc_cidr" {
  type    = string
  default = "10.42.0.0/16"
}

variable "enable_nat_gateway" {
  type    = bool
  default = true
}

variable "runner_image_uri" {
  type = string
}

variable "ecr_force_delete" {
  type    = bool
  default = false
}

variable "enable_egress_proxy" {
  type    = bool
  default = false
}

variable "enable_public_alb" {
  type    = bool
  default = false
}

variable "public_hostname" {
  type    = string
  default = ""
}

variable "route53_zone_id" {
  type    = string
  default = ""
}

variable "egress_proxy_image_uri" {
  type    = string
  default = ""
}

variable "deletion_protection" {
  type    = bool
  default = false
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

variable "runner_cpu_architecture" {
  type    = string
  default = "ARM64"
}

variable "checkpoint_retention_days" {
  type    = number
  default = 7
}

variable "log_retention_days" {
  type    = number
  default = 14
}

variable "ttl_cleanup_schedule" {
  type    = string
  default = "rate(1 minute)"
}

variable "ttl_max_managed_runtime_seconds" {
  type    = number
  default = 28800
}
