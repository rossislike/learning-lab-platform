output "state_bucket_name" {
  description = "S3 bucket used for Terraform state and native lock files."
  value       = aws_s3_bucket.terraform_state.id
}

output "state_kms_key_arn" {
  description = "KMS key ARN used by the S3 backend."
  value       = aws_kms_key.terraform_state.arn
}

output "runner_backend_config" {
  description = "Non-secret values for the runner stack backend configuration."
  value = {
    bucket                = aws_s3_bucket.terraform_state.id
    encrypt               = true
    key                   = "${var.project_name}/${var.environment}/terraform.tfstate"
    kms_key_id            = aws_kms_key.terraform_state.arn
    region                = var.aws_region
    expected_bucket_owner = var.expected_aws_account_id
    use_lockfile          = true
  }
}

output "bootstrap_backend_config" {
  description = "Non-secret values for migrating this bootstrap stack to its own S3 backend."
  value = {
    bucket                = aws_s3_bucket.terraform_state.id
    encrypt               = true
    key                   = "${var.project_name}/${var.environment}/bootstrap/terraform.tfstate"
    kms_key_id            = aws_kms_key.terraform_state.arn
    region                = var.aws_region
    expected_bucket_owner = var.expected_aws_account_id
    use_lockfile          = true
  }
}
