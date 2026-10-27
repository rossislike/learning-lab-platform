# DNS and certificates.
#
#   app.<env>.<parent>     → CloudFront (frontend)        A/AAAA alias, Terraform
#   *.<env>.<parent>       → ALB (gateway, sessions)      CNAME, written by scripts/deploy-dev.mjs
#                                                         once the Ingress has a load balancer
#
# One wildcard certificate per region: us-east-2 for the ALB, us-east-1 for
# CloudFront. Both are DNS-validated in the hosted zone.
#
# create_dns_zone = true: the validations below wait until the new zone is
# delegated from the parent, and the name_servers output only appears after
# an apply finishes. Apply the zone alone first (docs/dev-environment.md):
#   terraform apply -var-file=dev.tfvars -target=module.platform.aws_route53_zone.environment

locals {
  environment_domain = "${var.environment}.${var.parent_domain}"
  app_domain         = "app.${local.environment_domain}"
  wildcard_domain    = "*.${local.environment_domain}"
}

data "aws_route53_zone" "existing" {
  count = var.create_dns_zone ? 0 : 1

  name         = coalesce(var.dns_zone_name, var.parent_domain)
  private_zone = false
}

resource "aws_route53_zone" "environment" {
  count = var.create_dns_zone ? 1 : 0

  name    = local.environment_domain
  comment = "${var.name}: delegate from ${var.parent_domain} with the name_servers output"
}

locals {
  zone_id = var.create_dns_zone ? aws_route53_zone.environment[0].zone_id : data.aws_route53_zone.existing[0].zone_id
}

resource "aws_acm_certificate" "alb" {
  domain_name               = local.wildcard_domain
  subject_alternative_names = [local.environment_domain]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_acm_certificate" "cloudfront" {
  provider = aws.us_east_1

  domain_name               = local.wildcard_domain
  subject_alternative_names = [local.environment_domain]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

# Validation records, one set per certificate, keyed by domain name (known at
# plan time; the record names and values are not). This is the pattern in the
# aws_acm_certificate_validation provider docs. The wildcard and the apex share
# one validation record, and both certificates normally ask for the same
# CNAME, so allow_overwrite lets the second write converge on the same value
# instead of failing on an existing record.
locals {
  alb_validation = {
    for dvo in aws_acm_certificate.alb.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }
  cloudfront_validation = {
    for dvo in aws_acm_certificate.cloudfront.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }
}

resource "aws_route53_record" "alb_validation" {
  for_each = local.alb_validation

  zone_id         = local.zone_id
  name            = each.value.name
  type            = each.value.type
  ttl             = 60
  records         = [each.value.record]
  allow_overwrite = true
}

resource "aws_route53_record" "cloudfront_validation" {
  for_each = local.cloudfront_validation

  zone_id         = local.zone_id
  name            = each.value.name
  type            = each.value.type
  ttl             = 60
  records         = [each.value.record]
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "alb" {
  certificate_arn         = aws_acm_certificate.alb.arn
  validation_record_fqdns = [for record in aws_route53_record.alb_validation : record.fqdn]
}

resource "aws_acm_certificate_validation" "cloudfront" {
  provider = aws.us_east_1

  certificate_arn         = aws_acm_certificate.cloudfront.arn
  validation_record_fqdns = [for record in aws_route53_record.cloudfront_validation : record.fqdn]
}

resource "aws_route53_record" "app" {
  for_each = toset(["A", "AAAA"])

  zone_id = local.zone_id
  name    = local.app_domain
  type    = each.value

  alias {
    name                   = aws_cloudfront_distribution.frontend.domain_name
    zone_id                = aws_cloudfront_distribution.frontend.hosted_zone_id
    evaluate_target_health = false
  }
}
