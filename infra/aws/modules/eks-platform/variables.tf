variable "name" {
  description = "Base name for every resource (cluster, VPC, roles, buckets)."
  type        = string
  default     = "learning-lab-dev"

  validation {
    # Bucket names append "-frontend-<account id>-<region>" (up to 43
    # characters) and S3 allows 63.
    condition     = can(regex("^[a-z][a-z0-9-]{2,19}$", var.name))
    error_message = "name must be lowercase letters, digits and dashes (3-20 characters)."
  }
}

variable "environment" {
  description = "Hosted environment this platform serves (ADR 0007 allows only dev)."
  type        = string
  default     = "dev"

  validation {
    condition     = var.environment == "dev"
    error_message = "environment must be dev (ADR 0007)."
  }
}

variable "aws_region" {
  description = "Region for the cluster, ECR, buckets and the ALB certificate."
  type        = string
  default     = "us-east-2"
}

variable "parent_domain" {
  description = "Parent DNS name. The app is served at app.<environment>.<parent_domain>; session endpoints are <prefix>-<route>.<environment>.<parent_domain>."
  type        = string

  validation {
    condition     = can(regex("^([a-z0-9-]+\\.)+[a-z]{2,}$", var.parent_domain))
    error_message = "parent_domain must be a lowercase DNS name without a trailing dot."
  }
}

variable "dns_zone_name" {
  description = "Route 53 public hosted zone that holds the records (parent_domain itself, or one of its parents). Looked up when create_dns_zone is false."
  type        = string
  default     = null
}

variable "create_dns_zone" {
  description = "Create a public hosted zone for <environment>.<parent_domain> instead of using an existing zone. Delegate it from the parent with the name_servers output."
  type        = bool
  default     = false
}

variable "kubernetes_version" {
  description = "EKS Kubernetes version. The cluster uses standard support only (upgrade_policy), so keep this on a version in standard support; 1.34 is the newest one this module was written against (check `aws eks describe-cluster-versions` before moving to 1.35+)."
  type        = string
  default     = "1.34"
}

variable "cluster_endpoint_public_access_cidrs" {
  description = "CIDRs allowed to reach the public EKS API endpoint. Narrow to the operator's addresses when practical."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "vpc_cidr" {
  description = "VPC CIDR. Four /20 subnets are carved out of it (two public, two private)."
  type        = string
  default     = "10.40.0.0/16"
}

variable "availability_zone_count" {
  description = "Number of availability zones (subnet pairs)."
  type        = number
  default     = 2

  validation {
    condition     = var.availability_zone_count >= 2 && var.availability_zone_count <= 3
    error_message = "availability_zone_count must be 2 or 3."
  }
}

variable "cluster_admin_principal_arns" {
  description = "IAM principals (users or roles) granted cluster-admin through EKS access entries, in addition to the principal that creates the cluster. Do not list the creating principal: bootstrap_cluster_creator_admin_permissions already gave it an access entry, and a second one fails with ResourceInUseException."
  type        = list(string)
  default     = []
}

variable "platform_namespace" {
  description = "Namespace the Helm chart is installed into (Pod Identity association target)."
  type        = string
  default     = "learning-lab"
}

variable "dispatcher_service_account" {
  description = "Service account name of the dispatcher in platform_namespace (see deploy/helm/learning-lab)."
  type        = string
  default     = "llp-dispatcher"
}

variable "cluster_log_retention_days" {
  description = "Retention for the control-plane log group."
  type        = number
  default     = 14
}

variable "alert_email" {
  description = "Email subscribed to the environment alerts topic (alarms, budget). Null for topic only."
  type        = string
  default     = null
}

variable "daily_cost_budget_usd" {
  description = "Daily account spend (USD) above which the budget notifies the alerts topic."
  type        = number
  default     = 10
}

variable "gateway_alb_arn_suffix" {
  description = "LoadBalancer dimension of the Ingress ALB (app/k8s-…/…), from `npm run deploy:dev -- status`; enables the gateway 5xx alarm."
  type        = string
  default     = null
}
