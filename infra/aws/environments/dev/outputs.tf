# Everything scripts/deploy-dev.mjs needs (`terraform output -json`).

output "cluster_name" {
  value = module.platform.cluster_name
}

output "cluster_dns_ip" {
  description = "Cluster DNS service address (<service CIDR>.10). The sessions egress NetworkPolicy allows DNS to it (sessions.dnsServiceIp)."
  value       = cidrhost(module.platform.service_ipv4_cidr, 10)
}

output "vpc_id" {
  description = "deploy:dev teardown waits for the Ingress load balancer in this VPC to go."
  value       = module.platform.vpc_id
}

output "aws_region" {
  value = var.aws_region
}

output "ecr_repository_urls" {
  value = module.platform.ecr_repository_urls
}

output "bundles_bucket" {
  value = module.platform.bundles_bucket
}

output "frontend_bucket" {
  value = module.platform.frontend_bucket
}

output "cloudfront_distribution_id" {
  value = module.platform.cloudfront_distribution_id
}

output "app_url" {
  value = module.platform.app_url
}

output "environment_domain" {
  value = module.platform.environment_domain
}

output "alb_certificate_arn" {
  value = module.platform.alb_certificate_arn
}

output "dns_zone_id" {
  value = module.platform.dns_zone_id
}

output "name_servers" {
  value = module.platform.name_servers
}

output "dispatcher_role_arn" {
  value = module.platform.dispatcher_role_arn
}

output "alerts_topic_arn" {
  value = module.platform.alerts_topic_arn
}

output "github_deploy_role_arn" {
  description = "AWS_DEPLOY_ROLE_ARN repository variable for the GitHub Actions deploy workflow."
  value       = module.github_deploy.role_arn
}
