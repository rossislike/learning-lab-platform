variable "aws_region" {
  description = "AWS region for the Terraform state backend."
  type        = string
  default     = "us-east-2"
}

variable "environment" {
  description = "Environment whose Terraform state is stored in this backend."
  type        = string
  default     = "production"

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}

variable "expected_aws_account_id" {
  description = "Twelve-digit AWS account ID in which the backend must be created."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.expected_aws_account_id))
    error_message = "expected_aws_account_id must be a twelve-digit AWS account ID."
  }
}

variable "project_name" {
  description = "Stable project name used in backend resource names and tags."
  type        = string
  default     = "learning-lab-platform"

  validation {
    condition = (
      length(var.project_name) >= 3 &&
      length(var.project_name) <= 21 &&
      can(regex("^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$", var.project_name)) &&
      !strcontains(var.project_name, "--")
    )
    error_message = "project_name must be 3 to 21 lowercase letters, numbers, or single hyphens and must start and end with a letter or number."
  }
}

variable "state_bucket_name" {
  description = "Optional globally unique S3 bucket name. The default includes the AWS account and region."
  type        = string
  default     = null

  validation {
    condition = var.state_bucket_name == null || (
      length(var.state_bucket_name) >= 3 &&
      length(var.state_bucket_name) <= 63 &&
      can(regex("^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$", var.state_bucket_name)) &&
      !strcontains(var.state_bucket_name, "--") &&
      !can(regex("^[0-9]{1,3}(?:\\.[0-9]{1,3}){3}$", var.state_bucket_name)) &&
      !can(regex("^(xn--|sthree-|amzn-s3-demo-)", var.state_bucket_name)) &&
      !can(regex("(-s3alias|--ol-s3|\\.mrap|--x-s3|--table-s3)$", var.state_bucket_name))
    )
    error_message = "state_bucket_name must be a valid 3 to 63 character, hyphen-separated S3 bucket name and cannot use IP or AWS-reserved forms."
  }
}
