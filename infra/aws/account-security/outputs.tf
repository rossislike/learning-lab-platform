output "cloudtrail_arn" { value = aws_cloudtrail.management.arn }
output "cloudtrail_log_bucket" { value = aws_s3_bucket.cloudtrail.id }
output "cloudtrail_log_group" { value = aws_cloudwatch_log_group.cloudtrail.name }
output "guardduty_detector_id" { value = data.aws_guardduty_detector.current.id }
output "github_oidc_provider_arn" { value = aws_iam_openid_connect_provider.github_actions.arn }
output "security_alert_topic_arn" { value = aws_sns_topic.security_alerts.arn }
output "security_alert_email_configured" {
  description = "Whether Terraform has configured the required email subscription. Confirmation state must be checked in SNS."
  value       = true
}
