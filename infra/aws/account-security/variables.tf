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

variable "enable_learning_lab_alarms" {
  description = "Create the project CloudWatch security alarms while hosted infrastructure is deployed. This is controlled by the tracked alarm lifecycle auto variable file."
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
