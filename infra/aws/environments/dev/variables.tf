variable "aws_region" {
  description = "Region for the dev environment."
  type        = string
  default     = "us-east-2"
}

variable "expected_aws_account_id" {
  description = "Twelve-digit AWS account ID this root may deploy to."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.expected_aws_account_id))
    error_message = "expected_aws_account_id must be a twelve-digit AWS account ID."
  }
}

variable "parent_domain" {
  description = "Parent DNS name; the app is app.dev.<parent_domain> (config/hosted-environments.json)."
  type        = string
}

variable "dns_zone_name" {
  description = "Existing Route 53 public zone holding parent_domain (defaults to parent_domain). Ignored when create_dns_zone is true."
  type        = string
  default     = null
}

variable "create_dns_zone" {
  description = "Create a hosted zone for dev.<parent_domain> and delegate it from the parent by hand."
  type        = bool
  default     = false
}

variable "kubernetes_version" {
  description = "EKS Kubernetes version (standard support only; see modules/eks-platform)."
  type        = string
  default     = "1.34"
}

variable "cluster_endpoint_public_access_cidrs" {
  description = "CIDRs allowed to reach the public EKS API endpoint."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "cluster_admin_principal_arns" {
  description = "Extra IAM principals granted cluster-admin. Do not list the applying principal: it is admin already through its bootstrap access entry, and a duplicate entry fails."
  type        = list(string)
  default     = []
}
