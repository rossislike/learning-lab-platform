output "cluster_name" {
  value = aws_eks_cluster.this.name
}

output "cluster_endpoint" {
  value = aws_eks_cluster.this.endpoint
}

output "cluster_arn" {
  value = aws_eks_cluster.this.arn
}

output "service_ipv4_cidr" {
  description = "Kubernetes Service CIDR. Its .10 address is the cluster DNS service (CoreDNS on Auto Mode)."
  value       = aws_eks_cluster.this.kubernetes_network_config[0].service_ipv4_cidr
}

output "vpc_id" {
  value = aws_vpc.this.id
}

output "public_subnet_ids" {
  value = [for subnet in aws_subnet.public : subnet.id]
}

output "ecr_repository_urls" {
  description = "ECR repository URLs keyed by image name (platform, session-workspace)."
  value       = { for key, repository in aws_ecr_repository.this : key => repository.repository_url }
}

output "ecr_repository_arns" {
  value = [for repository in aws_ecr_repository.this : repository.arn]
}

output "bundles_bucket" {
  value = aws_s3_bucket.bundles.bucket
}

output "frontend_bucket" {
  value = aws_s3_bucket.frontend.bucket
}

output "cloudfront_distribution_id" {
  value = aws_cloudfront_distribution.frontend.id
}

output "app_url" {
  value = "https://${local.app_domain}"
}

output "environment_domain" {
  description = "Host suffix for session endpoints (GATEWAY_HOST_SUFFIX)."
  value       = local.environment_domain
}

output "alb_certificate_arn" {
  description = "Wildcard certificate for the gateway Ingress (alb.ingress.kubernetes.io/certificate-arn)."
  value       = aws_acm_certificate_validation.alb.certificate_arn
}

output "dns_zone_id" {
  value = local.zone_id
}

output "name_servers" {
  description = "When create_dns_zone is true: NS records to add at the parent for <environment>.<parent_domain>."
  value       = var.create_dns_zone ? aws_route53_zone.environment[0].name_servers : null
}

output "dispatcher_role_arn" {
  value = aws_iam_role.dispatcher.arn
}

output "alerts_topic_arn" {
  value = aws_sns_topic.alerts.arn
}

output "bundles_bucket_arn" {
  value = aws_s3_bucket.bundles.arn
}

output "frontend_bucket_arn" {
  value = aws_s3_bucket.frontend.arn
}

output "cloudfront_distribution_arn" {
  value = aws_cloudfront_distribution.frontend.arn
}
