# Operational alarms (ROADMAP Phase 6). Signals come from the dispatcher
# (CloudWatch metrics it publishes with its Pod Identity role), from the
# Ingress ALB, and from AWS Budgets. They notify an environment alerts topic
# (separate from account-security's security topic, whose policy is scoped to
# CloudTrail-derived alarms); subscribe an email with `alert_email`.

resource "aws_sns_topic" "alerts" {
  name = "${var.name}-alerts"
}

data "aws_iam_policy_document" "alerts" {
  statement {
    sid       = "CloudWatchAlarms"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]

    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }

  statement {
    sid       = "Budgets"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]

    principals {
      type        = "Service"
      identifiers = ["budgets.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_sns_topic_policy" "alerts" {
  arn    = aws_sns_topic.alerts.arn
  policy = data.aws_iam_policy_document.alerts.json
}

resource "aws_sns_topic_subscription" "alerts_email" {
  count = var.alert_email == null ? 0 : 1

  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# The dispatcher publishes LearningLab/Dispatcher metrics (Heartbeat,
# ActiveSessions, LaunchFailures, LostPods, PodsLaunched) through its Pod
# Identity role. LaunchFailures counts only sessions that failed to start;
# running sessions whose pod disappeared are LostPods (not alarmed).
data "aws_iam_policy_document" "dispatcher_metrics" {
  statement {
    sid       = "PutMetrics"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = [local.metrics_namespace]
    }
  }
}

resource "aws_iam_role_policy" "dispatcher_metrics" {
  name   = "metrics"
  role   = aws_iam_role.dispatcher.id
  policy = data.aws_iam_policy_document.dispatcher_metrics.json
}

locals {
  metrics_namespace = "LearningLab/Dispatcher"
  metric_dimensions = { Environment = var.environment }
}

# No heartbeat for 10 minutes: the dispatcher is down (or cannot reach
# CloudWatch). Missing data breaches on purpose.
resource "aws_cloudwatch_metric_alarm" "dispatcher_heartbeat" {
  alarm_name          = "${var.name}-dispatcher-heartbeat"
  alarm_description   = "The session dispatcher has not reported a heartbeat metric for 10 minutes."
  namespace           = local.metrics_namespace
  metric_name         = "Heartbeat"
  dimensions          = local.metric_dimensions
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "launch_failures" {
  alarm_name          = "${var.name}-session-launch-failures"
  alarm_description   = "Three or more learner sessions failed to launch within 15 minutes."
  namespace           = local.metrics_namespace
  metric_name         = "LaunchFailures"
  dimensions          = local.metric_dimensions
  statistic           = "Sum"
  period              = 900
  evaluation_periods  = 1
  threshold           = 3
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# Gateway 5xx through the ALB. The ALB is created by the Ingress, so its
# identifier is an input: scripts/deploy-dev.mjs status prints it
# (`app/k8s-…/…`), set `gateway_alb_arn_suffix` and re-apply.
resource "aws_cloudwatch_metric_alarm" "gateway_5xx" {
  count = var.gateway_alb_arn_suffix == null ? 0 : 1

  alarm_name          = "${var.name}-gateway-5xx"
  alarm_description   = "The gateway ALB returned 10 or more 5xx responses (ALB or target) in 5 minutes."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  threshold           = 10
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]

  # A missing series (no 5xx of that kind in the period) would make the sum
  # missing too; FILL treats it as 0.
  metric_query {
    id          = "total"
    expression  = "FILL(elb, 0) + FILL(target, 0)"
    label       = "5xx responses"
    return_data = true
  }

  metric_query {
    id = "elb"

    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "HTTPCode_ELB_5XX_Count"
      period      = 300
      stat        = "Sum"
      dimensions  = { LoadBalancer = var.gateway_alb_arn_suffix }
    }
  }

  metric_query {
    id = "target"

    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "HTTPCode_Target_5XX_Count"
      period      = 300
      stat        = "Sum"
      dimensions  = { LoadBalancer = var.gateway_alb_arn_suffix }
    }
  }
}

# Daily spend guard for the whole account (the dev environment is the only
# hosted workload). Actual spend above the limit notifies the alerts topic
# (which emails `alert_email` through its subscription). DAILY budgets do not
# support FORECASTED notifications, so there is only the ACTUAL one.
resource "aws_budgets_budget" "daily" {
  name         = "${var.name}-daily"
  budget_type  = "COST"
  limit_amount = tostring(var.daily_cost_budget_usd)
  limit_unit   = "USD"
  time_unit    = "DAILY"

  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 100
    threshold_type            = "PERCENTAGE"
    notification_type         = "ACTUAL"
    subscriber_sns_topic_arns = [aws_sns_topic.alerts.arn]
  }

  depends_on = [aws_sns_topic_policy.alerts]
}
