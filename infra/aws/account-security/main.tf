data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_guardduty_detector" "current" {}

locals {
  name                = "learning-lab-platform"
  github_oidc_host    = "token.actions.githubusercontent.com"
  trail_name          = "${local.name}-management-events"
  trail_arn           = "arn:${data.aws_partition.current.partition}:cloudtrail:${var.aws_region}:${data.aws_caller_identity.current.account_id}:trail/${local.trail_name}"
  cloudtrail_bucket   = "llp-${substr(sha1(local.name), 0, 10)}-account-${data.aws_caller_identity.current.account_id}-${var.aws_region}-trail"
  security_topic_name = "${local.name}-security-alerts"
  common_tags = {
    Environment = "account"
    ManagedBy   = "terraform"
    Project     = local.name
    Root        = "account-security"
  }
}

resource "aws_iam_openid_connect_provider" "github_actions" {
  url             = "https://${local.github_oidc_host}"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = var.github_oidc_thumbprints
}

check "expected_account" {
  assert {
    condition     = data.aws_caller_identity.current.account_id == var.expected_aws_account_id
    error_message = "The active AWS account does not match expected_aws_account_id."
  }
}

check "guardduty_enabled" {
  assert {
    condition     = data.aws_guardduty_detector.current.status == "ENABLED"
    error_message = "GuardDuty must be enabled before account security can be applied."
  }

  assert {
    condition = anytrue([
      for feature in data.aws_guardduty_detector.current.features :
      feature.name == "RUNTIME_MONITORING" && feature.status == "ENABLED"
    ])
    error_message = "GuardDuty Runtime Monitoring must be enabled."
  }

  assert {
    condition = anytrue(flatten([
      for feature in data.aws_guardduty_detector.current.features : [
        for configuration in feature.additional_configuration :
        feature.name == "RUNTIME_MONITORING" && configuration.name == "ECS_FARGATE_AGENT_MANAGEMENT" && configuration.status == "ENABLED"
      ]
    ]))
    error_message = "GuardDuty ECS Fargate agent management must be enabled."
  }
}

resource "aws_kms_key" "cloudtrail" {
  description             = "Encrypts learning lab management event CloudTrail logs"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.cloudtrail_kms.json

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_alias" "cloudtrail" {
  name          = "alias/${local.name}-cloudtrail"
  target_key_id = aws_kms_key.cloudtrail.key_id
}

data "aws_iam_policy_document" "cloudtrail_kms" {
  statement {
    sid       = "EnableAccountAdministration"
    actions   = ["kms:*"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }

  statement {
    sid       = "AllowCloudTrailEncryption"
    actions   = ["kms:GenerateDataKey*"]
    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.trail_arn]
    }

    condition {
      test     = "StringLike"
      variable = "kms:EncryptionContext:aws:cloudtrail:arn"
      values   = ["arn:${data.aws_partition.current.partition}:cloudtrail:*:${data.aws_caller_identity.current.account_id}:trail/*"]
    }
  }

  statement {
    sid       = "AllowCloudTrailKeyDescription"
    actions   = ["kms:DescribeKey"]
    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.trail_arn]
    }
  }
}

resource "aws_s3_bucket" "cloudtrail" {
  bucket = local.cloudtrail_bucket

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_ownership_controls" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id

  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.cloudtrail.arn
      sse_algorithm     = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id

  rule {
    id     = "retain-management-events"
    status = "Enabled"
    filter {}

    expiration { days = 365 }
    noncurrent_version_expiration { noncurrent_days = 365 }
    abort_incomplete_multipart_upload { days_after_initiation = 1 }
  }
}

data "aws_iam_policy_document" "cloudtrail_bucket" {
  statement {
    sid       = "CloudTrailAclCheck"
    actions   = ["s3:GetBucketAcl"]
    resources = [aws_s3_bucket.cloudtrail.arn]

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.trail_arn]
    }
  }

  statement {
    sid       = "CloudTrailWrite"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.cloudtrail.arn}/AWSLogs/${data.aws_caller_identity.current.account_id}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.trail_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-acl"
      values   = ["bucket-owner-full-control"]
    }
  }

  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.cloudtrail.arn, "${aws_s3_bucket.cloudtrail.arn}/*"]

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

resource "aws_s3_bucket_policy" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id
  policy = data.aws_iam_policy_document.cloudtrail_bucket.json
}

resource "aws_cloudwatch_log_group" "cloudtrail" {
  name              = "/aws/cloudtrail/${local.trail_name}"
  retention_in_days = 365
}

data "aws_iam_policy_document" "cloudtrail_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "cloudtrail" {
  name               = "${local.name}-cloudtrail-to-cloudwatch"
  assume_role_policy = data.aws_iam_policy_document.cloudtrail_assume.json
}

data "aws_iam_policy_document" "cloudtrail_logs" {
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.cloudtrail.arn}:*"]
  }
}

resource "aws_iam_role_policy" "cloudtrail_logs" {
  name   = "write-management-events"
  role   = aws_iam_role.cloudtrail.id
  policy = data.aws_iam_policy_document.cloudtrail_logs.json
}

resource "aws_cloudtrail" "management" {
  name                          = local.trail_name
  s3_bucket_name                = aws_s3_bucket.cloudtrail.id
  include_global_service_events = true
  is_multi_region_trail         = true
  enable_log_file_validation    = true
  enable_logging                = true
  kms_key_id                    = aws_kms_key.cloudtrail.arn
  cloud_watch_logs_group_arn    = "${aws_cloudwatch_log_group.cloudtrail.arn}:*"
  cloud_watch_logs_role_arn     = aws_iam_role.cloudtrail.arn

  event_selector {
    include_management_events = true
    read_write_type           = "All"
  }

  depends_on = [aws_s3_bucket_policy.cloudtrail, aws_iam_role_policy.cloudtrail_logs]

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_sns_topic" "security_alerts" {
  name              = local.security_topic_name
  kms_master_key_id = aws_kms_key.security_alerts.arn

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_key" "security_alerts" {
  description             = "Encrypts learning lab security notifications"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.security_alerts_kms.json

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_alias" "security_alerts" {
  name          = "alias/${local.name}-security-alerts"
  target_key_id = aws_kms_key.security_alerts.key_id
}

data "aws_iam_policy_document" "security_alerts_kms" {
  statement {
    sid       = "EnableAccountAdministration"
    actions   = ["kms:*"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }

  statement {
    sid       = "AllowSecurityAlertPublishers"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey*"]
    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com", "events.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

data "aws_iam_policy_document" "security_alerts" {
  statement {
    sid = "AccountOwner"
    actions = [
      "sns:AddPermission",
      "sns:DeleteTopic",
      "sns:GetTopicAttributes",
      "sns:ListSubscriptionsByTopic",
      "sns:Publish",
      "sns:RemovePermission",
      "sns:SetTopicAttributes",
      "sns:Subscribe",
    ]
    resources = [aws_sns_topic.security_alerts.arn]

    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }

  statement {
    sid       = "AllowCloudWatchAlarms"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.security_alerts.arn]

    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:${data.aws_partition.current.partition}:cloudwatch:${var.aws_region}:${data.aws_caller_identity.current.account_id}:alarm:*"]
    }
  }

  statement {
    sid       = "AllowEventBridge"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.security_alerts.arn]

    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:${data.aws_partition.current.partition}:events:${var.aws_region}:${data.aws_caller_identity.current.account_id}:rule/${local.name}-*"]
    }
  }
}

resource "aws_sns_topic_policy" "security_alerts" {
  arn    = aws_sns_topic.security_alerts.arn
  policy = data.aws_iam_policy_document.security_alerts.json
}

resource "aws_sns_topic_subscription" "email" {
  # Keep the existing email[0] state address so requiring a recipient does not
  # replace the already confirmed subscription.
  count = 1

  topic_arn = aws_sns_topic.security_alerts.arn
  protocol  = "email"
  endpoint  = var.security_alert_email
}

resource "aws_cloudwatch_event_rule" "guardduty_findings" {
  name        = "${local.name}-guardduty-findings"
  description = "Routes medium and higher severity GuardDuty findings to the security topic."

  event_pattern = jsonencode({
    source      = ["aws.guardduty"]
    detail-type = ["GuardDuty Finding"]
    detail = {
      severity = [{ numeric = [">=", 4] }]
    }
  })
}

resource "aws_cloudwatch_event_target" "guardduty_findings" {
  rule      = aws_cloudwatch_event_rule.guardduty_findings.name
  target_id = "security-alerts"
  arn       = aws_sns_topic.security_alerts.arn

  depends_on = [aws_sns_topic_policy.security_alerts]
}

# This route is independent of the CloudTrail log metric filters and CloudWatch
# alarms it monitors. It can still notify when those parts of the primary alert
# pipeline are modified or disabled.
resource "aws_cloudwatch_event_rule" "security_pipeline_changes" {
  name        = "${local.name}-security-pipeline-changes"
  description = "Routes security observability pipeline mutations directly to the security topic."

  event_pattern = jsonencode({
    detail-type = ["AWS API Call via CloudTrail"]
    detail = {
      eventSource = [
        "cloudtrail.amazonaws.com",
        "elasticloadbalancing.amazonaws.com",
        "events.amazonaws.com",
        "logs.amazonaws.com",
        "monitoring.amazonaws.com",
        "sns.amazonaws.com",
        "wafv2.amazonaws.com",
      ]
      eventName = [
        "AddPermission",
        "AssociateWebACL",
        "DeleteAlarms",
        "DeleteLogGroup",
        "DeleteLoggingConfiguration",
        "DeleteMetricFilter",
        "DeleteRule",
        "DeleteTopic",
        "DeleteTrail",
        "DeleteWebACL",
        "DisableAlarmActions",
        "DisableRule",
        "DisassociateWebACL",
        "EnableAlarmActions",
        "ModifyLoadBalancerAttributes",
        "PutEventSelectors",
        "PutLoggingConfiguration",
        "PutMetricAlarm",
        "PutMetricFilter",
        "PutRule",
        "PutTargets",
        "RemoveTargets",
        "RemovePermission",
        "SetSubscriptionAttributes",
        "SetTopicAttributes",
        "StartLogging",
        "StopLogging",
        "Subscribe",
        "Unsubscribe",
        "UpdateTrail",
        "UpdateWebACL",
      ]
    }
  })
}

resource "aws_cloudwatch_event_target" "security_pipeline_changes" {
  rule      = aws_cloudwatch_event_rule.security_pipeline_changes.name
  target_id = "security-alerts"
  arn       = aws_sns_topic.security_alerts.arn

  depends_on = [aws_sns_topic_policy.security_alerts]
}

locals {
  cloudtrail_alarm_filters = {
    root-account-usage = {
      description = "The AWS root account was used."
      pattern     = "{ $.userIdentity.type = Root && $.userIdentity.invokedBy NOT EXISTS && $.eventType != AwsServiceEvent }"
    }
    unauthorized-api-calls = {
      description = "An AWS API call was denied."
      pattern     = "{ ($.errorCode = *UnauthorizedOperation) || ($.errorCode = AccessDenied*) }"
    }
    console-login-without-mfa = {
      description = "A console login succeeded without MFA."
      pattern     = "{ ($.eventName = ConsoleLogin) && ($.additionalEventData.MFAUsed != Yes) }"
    }
    iam-policy-changes = {
      description = "An IAM identity or policy was changed."
      pattern     = "{ ($.eventSource = iam.amazonaws.com) && (($.eventName = PutGroupPolicy) || ($.eventName = PutRolePolicy) || ($.eventName = PutUserPolicy) || ($.eventName = CreatePolicy) || ($.eventName = DeletePolicy) || ($.eventName = CreatePolicyVersion) || ($.eventName = DeletePolicyVersion) || ($.eventName = SetDefaultPolicyVersion) || ($.eventName = AttachRolePolicy) || ($.eventName = DetachRolePolicy) || ($.eventName = AttachUserPolicy) || ($.eventName = DetachUserPolicy) || ($.eventName = AttachGroupPolicy) || ($.eventName = DetachGroupPolicy) || ($.eventName = PutRolePermissionsBoundary) || ($.eventName = DeleteRolePermissionsBoundary) || ($.eventName = PutUserPermissionsBoundary) || ($.eventName = DeleteUserPermissionsBoundary)) }"
    }
    iam-identity-and-credential-changes = {
      description = "An IAM identity, credential, group membership, or MFA configuration was changed."
      pattern     = "{ ($.eventSource = iam.amazonaws.com) && (($.eventName = AddUserToGroup) || ($.eventName = RemoveUserFromGroup) || ($.eventName = ChangePassword) || ($.eventName = CreateAccessKey) || ($.eventName = DeleteAccessKey) || ($.eventName = UpdateAccessKey) || ($.eventName = CreateLoginProfile) || ($.eventName = DeleteLoginProfile) || ($.eventName = UpdateLoginProfile) || ($.eventName = CreateRole) || ($.eventName = DeleteRole) || ($.eventName = UpdateAssumeRolePolicy) || ($.eventName = CreateUser) || ($.eventName = DeleteUser) || ($.eventName = DeactivateMFADevice) || ($.eventName = DeleteVirtualMFADevice) || ($.eventName = EnableMFADevice) || ($.eventName = ResyncMFADevice)) }"
    }
    cloudtrail-changes = {
      description = "CloudTrail configuration or logging was changed."
      pattern     = "{ ($.eventSource = cloudtrail.amazonaws.com) && (($.eventName = CreateTrail) || ($.eventName = UpdateTrail) || ($.eventName = DeleteTrail) || ($.eventName = StartLogging) || ($.eventName = StopLogging) || ($.eventName = PutEventSelectors)) }"
    }
    cloudwatch-alerting-changes = {
      description = "A security alarm, metric filter, or supporting log group was changed."
      pattern     = "{ (($.eventSource = monitoring.amazonaws.com) && (($.eventName = DeleteAlarms) || ($.eventName = DisableAlarmActions) || ($.eventName = EnableAlarmActions) || ($.eventName = PutMetricAlarm))) || (($.eventSource = logs.amazonaws.com) && (($.eventName = DeleteLogGroup) || ($.eventName = DeleteMetricFilter) || ($.eventName = PutMetricFilter))) }"
    }
    notification-routing-changes = {
      description = "An SNS destination or EventBridge notification route was changed."
      pattern     = "{ (($.eventSource = sns.amazonaws.com) && (($.eventName = AddPermission) || ($.eventName = DeleteTopic) || ($.eventName = RemovePermission) || ($.eventName = SetSubscriptionAttributes) || ($.eventName = SetTopicAttributes) || ($.eventName = Subscribe) || ($.eventName = Unsubscribe))) || (($.eventSource = events.amazonaws.com) && (($.eventName = DeleteRule) || ($.eventName = DisableRule) || ($.eventName = PutRule) || ($.eventName = PutTargets) || ($.eventName = RemoveTargets))) }"
    }
    edge-security-logging-changes = {
      description = "A WAF control, WAF log route, or ALB logging attribute was changed."
      pattern     = "{ (($.eventSource = wafv2.amazonaws.com) && (($.eventName = AssociateWebACL) || ($.eventName = DeleteLoggingConfiguration) || ($.eventName = DeleteWebACL) || ($.eventName = DisassociateWebACL) || ($.eventName = PutLoggingConfiguration) || ($.eventName = UpdateWebACL))) || (($.eventSource = elasticloadbalancing.amazonaws.com) && ($.eventName = ModifyLoadBalancerAttributes)) }"
    }
    guardduty-configuration-changes = {
      description = "GuardDuty detector, Runtime Monitoring, or member monitoring configuration was changed."
      pattern     = "{ ($.eventSource = guardduty.amazonaws.com) && (($.eventName = CreateDetector) || ($.eventName = DeleteDetector) || ($.eventName = UpdateDetector) || ($.eventName = UpdateMemberDetectors) || ($.eventName = UpdateOrganizationConfiguration) || ($.eventName = StartMonitoringMembers) || ($.eventName = StopMonitoringMembers) || ($.eventName = DisassociateFromAdministratorAccount) || ($.eventName = DisassociateMembers) || ($.eventName = DeleteMembers)) }"
    }
    kms-key-disable-or-delete = {
      description = "A KMS key was disabled or scheduled for deletion."
      pattern     = "{ ($.eventSource = kms.amazonaws.com) && (($.eventName = DisableKey) || ($.eventName = ScheduleKeyDeletion)) }"
    }
    security-group-changes = {
      description = "A VPC security group was changed."
      pattern     = "{ ($.eventSource = ec2.amazonaws.com) && (($.eventName = AuthorizeSecurityGroupIngress) || ($.eventName = AuthorizeSecurityGroupEgress) || ($.eventName = RevokeSecurityGroupIngress) || ($.eventName = RevokeSecurityGroupEgress) || ($.eventName = CreateSecurityGroup) || ($.eventName = DeleteSecurityGroup)) }"
    }
  }
}

resource "aws_cloudwatch_log_metric_filter" "security" {
  for_each = local.cloudtrail_alarm_filters

  name           = "${local.name}-${each.key}"
  log_group_name = aws_cloudwatch_log_group.cloudtrail.name
  pattern        = each.value.pattern

  metric_transformation {
    name      = replace(title(each.key), "-", "")
    namespace = "LearningLab/Security"
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "security" {
  for_each = local.cloudtrail_alarm_filters

  alarm_name          = "${local.name}-${each.key}"
  alarm_description   = each.value.description
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = aws_cloudwatch_log_metric_filter.security[each.key].metric_transformation[0].name
  namespace           = "LearningLab/Security"
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.security_alerts.arn]
}
