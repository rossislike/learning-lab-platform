locals {
  alb_access_log_bucket_name = "${local.bucket_prefix}-alb-logs"
}

resource "aws_s3_bucket" "alb_access_logs" {
  count = var.enable_security_observability ? 1 : 0

  bucket = local.alb_access_log_bucket_name

  lifecycle {
    prevent_destroy = true
  }

  tags = { Name = "${local.name}-alb-access-logs" }
}

resource "aws_s3_bucket_ownership_controls" "alb_access_logs" {
  count = var.enable_security_observability ? 1 : 0

  bucket = aws_s3_bucket.alb_access_logs[0].id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "alb_access_logs" {
  count = var.enable_security_observability ? 1 : 0

  bucket = aws_s3_bucket.alb_access_logs[0].id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "alb_access_logs" {
  count = var.enable_security_observability ? 1 : 0

  bucket = aws_s3_bucket.alb_access_logs[0].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "alb_access_logs" {
  count = var.enable_security_observability ? 1 : 0

  bucket = aws_s3_bucket.alb_access_logs[0].id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_lifecycle_configuration" "alb_access_logs" {
  count = var.enable_security_observability ? 1 : 0

  bucket = aws_s3_bucket.alb_access_logs[0].id

  rule {
    id     = "expire-alb-access-logs"
    status = "Enabled"
    filter {}

    expiration { days = var.alb_access_log_retention_days }
    noncurrent_version_expiration { noncurrent_days = var.alb_access_log_retention_days }
    abort_incomplete_multipart_upload { days_after_initiation = 1 }
  }
}

data "aws_iam_policy_document" "alb_access_logs" {
  count = var.enable_security_observability ? 1 : 0

  statement {
    sid       = "AllowAlbLogDelivery"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.alb_access_logs[0].arn}/alb/AWSLogs/${data.aws_caller_identity.current.account_id}/elasticloadbalancing/*"]

    principals {
      type        = "Service"
      identifiers = ["logdelivery.elasticloadbalancing.amazonaws.com"]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:${data.aws_partition.current.partition}:elasticloadbalancing:${var.aws_region}:${data.aws_caller_identity.current.account_id}:loadbalancer/*"]
    }
  }

  # ELB bucket validation does not supply aws:SourceArn in this account. Limit
  # that exception to the documented test object, while requiring SourceArn for
  # every delivered access log above.
  statement {
    sid       = "AllowAlbLogDeliveryValidation"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.alb_access_logs[0].arn}/alb/AWSLogs/${data.aws_caller_identity.current.account_id}/ELBAccessLogTestFile"]

    principals {
      type        = "Service"
      identifiers = ["logdelivery.elasticloadbalancing.amazonaws.com"]
    }
  }

  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.alb_access_logs[0].arn, "${aws_s3_bucket.alb_access_logs[0].arn}/*"]

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "alb_access_logs" {
  count = var.enable_security_observability ? 1 : 0

  bucket = aws_s3_bucket.alb_access_logs[0].id
  policy = data.aws_iam_policy_document.alb_access_logs[0].json
}

resource "aws_wafv2_web_acl" "public" {
  count = var.enable_security_observability ? 1 : 0

  name  = "${local.name}-public"
  scope = "REGIONAL"

  default_action {
    allow {}
  }

  rule {
    name     = "aws-ip-reputation"
    priority = 10
    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesAmazonIpReputationList"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-ip-reputation"
      sampled_requests_enabled   = false
    }
  }

  rule {
    name     = "aws-known-bad-inputs"
    priority = 20
    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-known-bad-inputs"
      sampled_requests_enabled   = false
    }
  }

  rule {
    name     = "aws-common-protections"
    priority = 30
    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-common-protections"
      sampled_requests_enabled   = false
    }
  }

  rule {
    name     = "per-ip-rate-limit"
    priority = 40

    action {
      block {}
    }

    statement {
      rate_based_statement {
        aggregate_key_type = "IP"
        limit              = 2000
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-per-ip-rate-limit"
      sampled_requests_enabled   = false
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${local.name}-public"
    sampled_requests_enabled   = false
  }

  tags = { Name = "${local.name}-public" }
}

resource "aws_wafv2_web_acl_association" "public" {
  count = var.enable_security_observability ? 1 : 0

  resource_arn = aws_lb.public[0].arn
  web_acl_arn  = aws_wafv2_web_acl.public[0].arn
}

resource "aws_cloudwatch_log_group" "waf" {
  count = var.enable_security_observability ? 1 : 0

  name              = "aws-waf-logs-${local.name}"
  retention_in_days = var.log_retention_days
}

resource "aws_wafv2_web_acl_logging_configuration" "public" {
  count = var.enable_security_observability ? 1 : 0

  log_destination_configs = [aws_cloudwatch_log_group.waf[0].arn]
  resource_arn            = aws_wafv2_web_acl.public[0].arn

  redacted_fields {
    single_header {
      name = "authorization"
    }
  }

  redacted_fields {
    single_header {
      name = "cookie"
    }
  }

  redacted_fields {
    single_header {
      name = "x-api-key"
    }
  }

  redacted_fields {
    single_header {
      name = "x-auth-token"
    }
  }

  redacted_fields {
    single_header {
      name = "x-amz-security-token"
    }
  }

  redacted_fields {
    query_string {}
  }
}

resource "aws_cloudwatch_metric_alarm" "waf_blocked_requests" {
  count = var.enable_security_observability ? 1 : 0

  alarm_name          = "${local.name}-waf-blocked-requests"
  alarm_description   = "AWS WAF blocked at least 100 requests in five minutes."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "BlockedRequests"
  namespace           = "AWS/WAFV2"
  period              = 300
  statistic           = "Sum"
  threshold           = 100
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.security_alarm_topic_arn]

  dimensions = {
    Region = var.aws_region
    Rule   = "ALL"
    WebACL = aws_wafv2_web_acl.public[0].name
  }
}

resource "aws_cloudwatch_metric_alarm" "alb_rejected_connections" {
  count = var.enable_security_observability ? 1 : 0

  alarm_name          = "${local.name}-alb-rejected-connections"
  alarm_description   = "The public ALB rejected a connection."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "RejectedConnectionCount"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.security_alarm_topic_arn]

  dimensions = {
    LoadBalancer = aws_lb.public[0].arn_suffix
  }
}
