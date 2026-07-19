import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8")

test("account security root owns management audit and alert routing", async () => {
  const [source, variables, outputs] = await Promise.all([
    read("infra/aws/account-security/main.tf"),
    read("infra/aws/account-security/variables.tf"),
    read("infra/aws/account-security/outputs.tf"),
  ])

  assert.match(source, /resource "aws_cloudtrail" "management"/)
  assert.match(source, /is_multi_region_trail\s+= true/)
  assert.match(source, /include_global_service_events\s+= true/)
  assert.match(source, /enable_log_file_validation\s+= true/)
  assert.match(source, /include_management_events = true/)
  assert.match(source, /read_write_type\s+= "All"/)
  assert.match(source, /resource "aws_kms_key" "cloudtrail"/)
  assert.match(source, /prevent_destroy = true/)
  assert.match(source, /resource "aws_cloudwatch_event_rule" "guardduty_findings"/)
  assert.match(source, /feature\.name == "RUNTIME_MONITORING"/)
  assert.match(source, /configuration\.name == "ECS_FARGATE_AGENT_MANAGEMENT"/)
  assert.match(source, /resource "aws_sns_topic" "security_alerts"/)
  assert.match(source, /kms_master_key_id = aws_kms_key\.security_alerts\.arn/)
  assert.match(source, /resource "aws_sns_topic" "security_alerts"[\s\S]*?lifecycle \{\s*prevent_destroy = true\s*\}/)
  assert.match(source, /root-account-usage/)
  assert.match(source, /unauthorized-api-calls/)
  assert.match(source, /cloudtrail-changes/)
  assert.match(source, /guardduty-configuration-changes/)
  assert.match(source, /\$\.eventName = UpdateDetector/)
  assert.match(source, /\$\.eventName = DeleteDetector/)
  assert.match(source, /\$\.eventName = SetDefaultPolicyVersion/)
  assert.match(source, /\$\.eventName = AddUserToGroup/)
  assert.match(source, /\$\.eventName = ChangePassword/)
  assert.match(source, /resource "aws_sns_topic_subscription" "email" \{\s*#.*\n\s*#.*\n\s*count = 1/s)
  assert.match(variables, /variable "security_alert_email"[\s\S]*condition\s+= can\(regex/)
  assert.doesNotMatch(variables, /variable "security_alert_email"[\s\S]*?default\s+= ""/)
  assert.match(outputs, /output "security_alert_email_configured"/)
  assert.doesNotMatch(outputs, /confirmation-required/)
  assert.match(source, /noncurrent_version_expiration \{ noncurrent_days = 365 \}/)
  assert.match(source, /resource "aws_cloudwatch_event_rule" "security_pipeline_changes"/)
  assert.match(source, /resource "aws_cloudwatch_event_target" "security_pipeline_changes"/)
  assert.match(source, /cloudwatch-alerting-changes/)
  assert.match(source, /notification-routing-changes/)
  assert.match(source, /edge-security-logging-changes/)
  for (const eventName of [
    "AddPermission",
    "DeleteAlarms",
    "DeleteMetricFilter",
    "DisableAlarmActions",
    "EnableAlarmActions",
    "SetTopicAttributes",
    "Unsubscribe",
    "RemoveTargets",
    "RemovePermission",
    "DisassociateWebACL",
    "DeleteLoggingConfiguration",
    "ModifyLoadBalancerAttributes",
  ]) {
    assert.match(source, new RegExp(`"${eventName}"`))
  }
})

test("hosted environments enable protected WAF and ALB observability", async () => {
  const [security, moduleMain, staging, production] = await Promise.all([
    read("infra/aws/modules/hosted-runner/security.tf"),
    read("infra/aws/modules/hosted-runner/main.tf"),
    read("infra/aws/environments/staging/main.tf"),
    read("infra/aws/environments/production/main.tf"),
  ])

  assert.match(security, /resource "aws_wafv2_web_acl" "public"/)
  assert.match(security, /AWSManagedRulesAmazonIpReputationList/)
  assert.match(security, /AWSManagedRulesKnownBadInputsRuleSet/)
  assert.match(security, /AWSManagedRulesCommonRuleSet/)
  assert.match(security, /rate_based_statement/)
  assert.match(security, /resource "aws_wafv2_web_acl_logging_configuration" "public"/)
  assert.match(security, /name = "authorization"/)
  assert.match(security, /name = "cookie"/)
  assert.match(security, /name = "x-api-key"/)
  assert.match(security, /name = "x-auth-token"/)
  assert.match(security, /name = "x-amz-security-token"/)
  assert.match(security, /query_string \{\}/)
  assert.match(security, /noncurrent_version_expiration \{ noncurrent_days = var\.alb_access_log_retention_days \}/)
  assert.doesNotMatch(security, /sampled_requests_enabled\s+= true/)
  assert.equal((security.match(/sampled_requests_enabled\s+= false/g) ?? []).length, 5)
  assert.match(security, /identifiers = \["logdelivery\.elasticloadbalancing\.amazonaws\.com"\]/)
  assert.match(security, /variable = "aws:SourceArn"/)
  assert.match(security, /:elasticloadbalancing:\$\{var\.aws_region\}:\$\{data\.aws_caller_identity\.current\.account_id\}:loadbalancer\/\*/)
  assert.match(security, /\/alb\/AWSLogs\/\$\{data\.aws_caller_identity\.current\.account_id\}\/elasticloadbalancing\/\*/)
  assert.match(security, /\/alb\/AWSLogs\/\$\{data\.aws_caller_identity\.current\.account_id\}\/ELBAccessLogTestFile/)
  assert.match(security, /sse_algorithm = "AES256"/)
  assert.match(security, /object_ownership = "BucketOwnerEnforced"/)
  assert.match(moduleMain, /aws_s3_bucket_policy\.alb_access_logs/)
  assert.match(moduleMain, /enabled = true/)

  for (const root of [staging, production]) {
    assert.match(root, /enable_security_observability\s+= true/)
    assert.match(root, /data "aws_sns_topic" "security_alerts"/)
    assert.match(root, /security_alarm_topic_arn\s+= data\.aws_sns_topic\.security_alerts\.arn/)
    assert.doesNotMatch(root, /security_alarm_topic_arn\s+= "arn:aws:sns:/)
  }
  assert.match(staging, /alb_access_log_retention_days\s+= 90/)
  assert.match(production, /alb_access_log_retention_days\s+= 365/)
})

test("roadmap is complete after an alert reaches a confirmed recipient", async () => {
  const [roadmap, validation] = await Promise.all([
    read("ROADMAP.md"),
    read("docs/aws-security-observability-validation.md"),
  ])

  assert.match(roadmap, /- \[x\] Add AWS WAF, ALB access logs, CloudTrail coverage, GuardDuty Runtime Monitoring, and security alarms\./)
  assert.match(validation, /normal request returned `503`/)
  assert.match(validation, /XSS probe returned `403`/)
  assert.match(validation, /confirmed recipient reported receiving the resulting alarm email/)
  assert.match(validation, /severity-8 sample finding `815fe07f0bc14e2dbc4b779587afd9ef`/)
  assert.match(validation, /type `Backdoor:EC2\/DenialOfService\.Tcp`/)
  assert.match(validation, /SNS recorded one delivered notification and zero failures/)
  assert.match(validation, /recipient confirmed email receipt on 2026-07-19/)
  assert.match(validation, /0 to add, 0 to change, 0 to destroy/)
})
