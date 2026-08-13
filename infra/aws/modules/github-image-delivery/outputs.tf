output "delivery_role_arn" {
  value = aws_iam_role.delivery.arn
}

output "github_oidc_provider_arn" {
  value = aws_iam_openid_connect_provider.github.arn
}

output "promotion_reader_role_arn" {
  value = var.create_production_promotion_reader ? aws_iam_role.promotion_reader[0].arn : null
}
