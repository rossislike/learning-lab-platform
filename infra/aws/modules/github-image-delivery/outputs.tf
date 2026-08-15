output "delivery_role_arn" {
  value = aws_iam_role.delivery.arn
}

output "github_oidc_provider_arn" {
  value = var.github_oidc_provider_arn
}
