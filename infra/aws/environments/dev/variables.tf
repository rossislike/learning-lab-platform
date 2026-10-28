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

variable "alert_email" {
  description = "Email for alarm and budget notifications (confirm the SNS subscription once)."
  type        = string
  default     = null
}

variable "daily_cost_budget_usd" {
  type    = number
  default = 10
}

variable "gateway_alb_arn_suffix" {
  description = "From `npm run deploy:dev -- status` after the first chart install; enables the gateway 5xx alarm."
  type        = string
  default     = null
}

variable "github_repository" {
  description = "Repository whose `dev` GitHub environment (deployment branches: main only) deploys to dev through GitHub Actions (OIDC)."
  type        = string
  default     = "rossislike/learning-lab-platform"
}

# The backend this root is initialised with (config/aws-terraform-backends.json);
# the GitHub deploy role reads the state to get the outputs.
variable "terraform_state_bucket" {
  type    = string
  default = "learning-lab-platform-production-tfstate-442359104502-us-east-2"
}

variable "terraform_state_key" {
  type    = string
  default = "learning-lab-platform/dev/terraform.tfstate"
}

variable "terraform_state_kms_key_arn" {
  type    = string
  default = "arn:aws:kms:us-east-2:442359104502:key/473fd4c0-6d38-4dc6-8a29-013b895a9eb2"
}

variable "github_sub_claim_prefix" {
  description = "OIDC subject prefix GitHub reports for the repository (gh api repos/<owner>/<repo>/actions/oidc/customization/sub → sub_claim_prefix)."
  type        = string
  default     = null
}
