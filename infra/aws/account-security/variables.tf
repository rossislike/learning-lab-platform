variable "aws_region" {
  description = "Home region for account security resources."
  type        = string
  default     = "us-east-2"
}

variable "expected_aws_account_id" {
  description = "Twelve-digit AWS account ID protected by this root."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.expected_aws_account_id))
    error_message = "expected_aws_account_id must be a twelve-digit AWS account ID."
  }
}

variable "security_alert_email" {
  description = "Required email endpoint for security notifications. AWS requires the recipient to confirm it."
  type        = string

  validation {
    condition     = can(regex("^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$", var.security_alert_email))
    error_message = "security_alert_email must be a valid, nonempty email address."
  }
}
