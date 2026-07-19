data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  name              = "${var.project_name}-${var.environment}"
  project_id        = substr(sha1(var.project_name), 0, 10)
  bucket_prefix     = "llp-${local.project_id}-${var.environment}-${data.aws_caller_identity.current.account_id}-${var.aws_region}"
  azs               = slice(data.aws_availability_zones.available.names, 0, 2)
  artifact_bucket   = var.deletion_protection ? aws_s3_bucket.artifacts_protected[0] : aws_s3_bucket.artifacts_disposable[0]
  checkpoint_bucket = var.deletion_protection ? aws_s3_bucket.checkpoints_protected[0] : aws_s3_bucket.checkpoints_disposable[0]
  data_kms_key      = var.deletion_protection ? aws_kms_key.data_protected[0] : aws_kms_key.data_disposable[0]
  service_secrets_kms_key = var.enable_service_secret_boundary ? (
    var.deletion_protection ? aws_kms_key.service_secrets_protected[0] : aws_kms_key.service_secrets_disposable[0]
  ) : null
  dispatcher_runner_shared_secret = var.enable_service_secret_boundary ? (
    var.deletion_protection ? aws_secretsmanager_secret.dispatcher_runner_shared_secret_protected[0] : aws_secretsmanager_secret.dispatcher_runner_shared_secret_disposable[0]
  ) : null
  proxy_repository  = var.enable_egress_proxy ? (var.deletion_protection ? aws_ecr_repository.proxy_protected[0] : aws_ecr_repository.proxy_disposable[0]) : null
  runner_repository = var.deletion_protection ? aws_ecr_repository.runner_protected[0] : aws_ecr_repository.runner_disposable[0]
  session_ports = {
    editor  = 3000
    preview = 5173
    tools   = 8080
  }
  interface_endpoint_services = toset([
    "ecr.api",
    "ecr.dkr",
    "ecs",
    "ecs-agent",
    "ecs-telemetry",
    "kms",
    "logs",
    "secretsmanager",
    "sts",
  ])
  runner_no_proxy = join(",", concat(
    ["127.0.0.1", "localhost"],
    var.enable_learner_metadata_boundary ? [] : [
      "169.254.169.254",
      "169.254.170.2",
    ],
    [
      "api.ecr.${var.aws_region}.amazonaws.com",
      "ecs.${var.aws_region}.amazonaws.com",
      "kms.${var.aws_region}.amazonaws.com",
      "logs.${var.aws_region}.amazonaws.com",
      "secretsmanager.${var.aws_region}.amazonaws.com",
      "sts.${var.aws_region}.amazonaws.com",
    ],
  ))
  runner_container_definition = {
    name      = "learning-lab-runner"
    image     = var.runner_image_uri
    essential = true
    environment = concat(
      [
        { name = "LAB_RUNNER_MODE", value = "aws-ecs-fargate" },
        { name = "AWS_REGION", value = var.aws_region }
      ],
      var.enable_egress_proxy ? [
        { name = "HTTP_PROXY", value = "http://${aws_lb.egress_proxy[0].dns_name}:${var.egress_proxy_port}" },
        { name = "HTTPS_PROXY", value = "http://${aws_lb.egress_proxy[0].dns_name}:${var.egress_proxy_port}" },
        { name = "NO_PROXY", value = local.runner_no_proxy },
        { name = "http_proxy", value = "http://${aws_lb.egress_proxy[0].dns_name}:${var.egress_proxy_port}" },
        { name = "https_proxy", value = "http://${aws_lb.egress_proxy[0].dns_name}:${var.egress_proxy_port}" },
        { name = "no_proxy", value = local.runner_no_proxy }
      ] : [],
    )
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.runner.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "ecs"
      }
    }
  }

}

resource "aws_vpc" "runner" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = { Name = "${local.name}-vpc" }
}

resource "aws_internet_gateway" "runner" {
  vpc_id = aws_vpc.runner.id
  tags   = { Name = "${local.name}-igw" }
}

resource "aws_subnet" "public" {
  for_each = { for index, az in local.azs : az => index }

  availability_zone       = each.key
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, each.value)
  map_public_ip_on_launch = false
  vpc_id                  = aws_vpc.runner.id

  tags = { Name = "${local.name}-public-${each.key}" }
}

resource "aws_subnet" "private" {
  for_each = { for index, az in local.azs : az => index }

  availability_zone = each.key
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, each.value + 10)
  vpc_id            = aws_vpc.runner.id

  tags = { Name = "${local.name}-private-${each.key}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.runner.id
  tags   = { Name = "${local.name}-public" }
}

resource "aws_route" "public_internet" {
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.runner.id
  route_table_id         = aws_route_table.public.id
}

resource "aws_route_table_association" "public" {
  for_each = aws_subnet.public

  route_table_id = aws_route_table.public.id
  subnet_id      = each.value.id
}

resource "aws_eip" "nat" {
  for_each = var.enable_nat_gateway ? aws_subnet.public : {}

  domain     = "vpc"
  depends_on = [aws_internet_gateway.runner]
  tags       = { Name = "${local.name}-nat-${each.key}" }
}

resource "aws_nat_gateway" "runner" {
  for_each = var.enable_nat_gateway ? aws_subnet.public : {}

  allocation_id = aws_eip.nat[each.key].id
  subnet_id     = each.value.id

  tags = { Name = "${local.name}-nat-${each.key}" }
}

resource "aws_route_table" "private" {
  for_each = aws_subnet.private

  vpc_id = aws_vpc.runner.id
  tags   = { Name = "${local.name}-private-${each.key}" }
}

resource "aws_route" "private_internet" {
  for_each = var.enable_nat_gateway ? aws_subnet.private : {}

  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.runner[each.key].id
  route_table_id         = aws_route_table.private[each.key].id
}

resource "aws_route_table_association" "private" {
  for_each = aws_subnet.private

  route_table_id = aws_route_table.private[each.key].id
  subnet_id      = each.value.id
}

resource "aws_security_group" "session_task" {
  name        = "${local.name}-session-task"
  description = "Outbound access for private hosted session tasks"
  vpc_id      = aws_vpc.runner.id

  tags = { Name = "${local.name}-session-task" }
}

resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "Public HTTPS ingress for the future session ALB"
  vpc_id      = aws_vpc.runner.id

  tags = { Name = "${local.name}-alb" }
}

resource "aws_security_group" "gateway" {
  name        = "${local.name}-gateway"
  description = "Private session gateway boundary"
  vpc_id      = aws_vpc.runner.id

  tags = { Name = "${local.name}-gateway" }
}

resource "aws_security_group" "dispatcher" {
  name        = "${local.name}-dispatcher"
  description = "Private dispatcher with no inbound path"
  vpc_id      = aws_vpc.runner.id

  tags = { Name = "${local.name}-dispatcher" }
}

resource "aws_security_group" "vpc_endpoints" {
  name        = "${local.name}-vpc-endpoints"
  description = "AWS PrivateLink endpoints for hosted workloads"
  vpc_id      = aws_vpc.runner.id

  tags = { Name = "${local.name}-vpc-endpoints" }
}

resource "aws_security_group" "egress_proxy" {
  name        = "${local.name}-egress-proxy"
  description = "Controlled external HTTPS egress boundary"
  vpc_id      = aws_vpc.runner.id

  tags = { Name = "${local.name}-egress-proxy" }
}

resource "aws_security_group" "egress_proxy_lb" {
  name        = "${local.name}-egress-proxy-lb"
  description = "Internal load balancer for the controlled egress proxy"
  vpc_id      = aws_vpc.runner.id

  tags = { Name = "${local.name}-egress-proxy-lb" }
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  for_each = toset(var.alb_ingress_cidrs)

  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = each.value
  from_port         = 443
  ip_protocol       = "tcp"
  to_port           = 443
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  for_each = var.enable_public_alb ? toset(var.alb_ingress_cidrs) : toset([])

  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = each.value
  from_port         = 80
  ip_protocol       = "tcp"
  to_port           = 80
}

resource "aws_vpc_security_group_egress_rule" "alb_to_gateway" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.gateway.id
  from_port                    = var.gateway_port
  ip_protocol                  = "tcp"
  to_port                      = var.gateway_port
}

resource "aws_vpc_security_group_ingress_rule" "gateway_from_alb" {
  security_group_id            = aws_security_group.gateway.id
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = var.gateway_port
  ip_protocol                  = "tcp"
  to_port                      = var.gateway_port
}

resource "aws_acm_certificate" "public" {
  count = var.enable_public_alb ? 1 : 0

  domain_name               = var.public_hostname
  subject_alternative_names = ["*.${var.public_hostname}"]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true

    precondition {
      condition = !var.enable_public_alb || (
        !data.aws_route53_zone.public[0].private_zone &&
        (
          var.public_hostname == trimsuffix(data.aws_route53_zone.public[0].name, ".") ||
          endswith(var.public_hostname, ".${trimsuffix(data.aws_route53_zone.public[0].name, ".")}")
        )
      )
      error_message = "public_hostname must be within the supplied public Route 53 hosted zone."
    }
  }

  tags = { Name = "${local.name}-public" }
}

data "aws_route53_zone" "public" {
  count = var.enable_public_alb ? 1 : 0

  zone_id = var.route53_zone_id
}

resource "aws_route53_record" "certificate_validation" {
  for_each = var.enable_public_alb ? { (var.public_hostname) = {
    name   = one(distinct([for option in aws_acm_certificate.public[0].domain_validation_options : option.resource_record_name]))
    record = one(distinct([for option in aws_acm_certificate.public[0].domain_validation_options : option.resource_record_value]))
    type   = one(distinct([for option in aws_acm_certificate.public[0].domain_validation_options : option.resource_record_type]))
  } } : {}

  name    = each.value.name
  records = [each.value.record]
  ttl     = 60
  type    = each.value.type
  zone_id = var.route53_zone_id
}

resource "aws_acm_certificate_validation" "public" {
  count = var.enable_public_alb ? 1 : 0

  certificate_arn         = aws_acm_certificate.public[0].arn
  validation_record_fqdns = [aws_route53_record.certificate_validation[var.public_hostname].fqdn]
}

resource "aws_lb" "public" {
  count = var.enable_public_alb ? 1 : 0

  name               = length(local.name) <= 29 ? substr("${local.name}-public", 0, 32) : "${substr(local.name, 0, 18)}-pub-${substr(sha1("${local.name}-public"), 0, 8)}"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = values(aws_subnet.public)[*].id

  drop_invalid_header_fields = true
  enable_deletion_protection = var.deletion_protection

  dynamic "access_logs" {
    for_each = var.enable_security_observability ? [1] : []

    content {
      bucket  = aws_s3_bucket.alb_access_logs[0].id
      enabled = true
      prefix  = "alb"
    }
  }

  depends_on = [
    aws_s3_bucket_ownership_controls.alb_access_logs,
    aws_s3_bucket_policy.alb_access_logs,
    aws_s3_bucket_server_side_encryption_configuration.alb_access_logs,
  ]

  tags = { Name = "${local.name}-public" }
}

resource "aws_lb_listener" "public_http" {
  count = var.enable_public_alb ? 1 : 0

  load_balancer_arn = aws_lb.public[0].arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "public_https" {
  count = var.enable_public_alb ? 1 : 0

  certificate_arn   = aws_acm_certificate_validation.public[0].certificate_arn
  load_balancer_arn = aws_lb.public[0].arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"

  default_action {
    type = "fixed-response"

    fixed_response {
      content_type = "application/json"
      message_body = jsonencode({
        environment = var.environment
        service     = "learning-lab-platform"
        status      = "gateway-deployment-pending"
      })
      status_code = "503"
    }
  }
}

resource "aws_route53_record" "public_ipv4" {
  count = var.enable_public_alb ? 1 : 0

  name    = var.public_hostname
  type    = "A"
  zone_id = var.route53_zone_id

  alias {
    evaluate_target_health = false
    name                   = aws_lb.public[0].dns_name
    zone_id                = aws_lb.public[0].zone_id
  }

  depends_on = [aws_lb_listener.public_https]
}

resource "aws_route53_record" "workspace_ipv4" {
  count = var.enable_public_alb ? 1 : 0

  name    = "*.${var.public_hostname}"
  type    = "A"
  zone_id = var.route53_zone_id

  alias {
    evaluate_target_health = false
    name                   = aws_lb.public[0].dns_name
    zone_id                = aws_lb.public[0].zone_id
  }

  depends_on = [aws_lb_listener.public_https]
}

resource "aws_vpc_security_group_egress_rule" "gateway_to_session" {
  for_each = local.session_ports

  security_group_id            = aws_security_group.gateway.id
  referenced_security_group_id = aws_security_group.session_task.id
  from_port                    = each.value
  ip_protocol                  = "tcp"
  to_port                      = each.value
}

resource "aws_vpc_security_group_ingress_rule" "session_from_gateway" {
  for_each = local.session_ports

  security_group_id            = aws_security_group.session_task.id
  referenced_security_group_id = aws_security_group.gateway.id
  from_port                    = each.value
  ip_protocol                  = "tcp"
  to_port                      = each.value
}

locals {
  private_workload_security_groups = {
    dispatcher = aws_security_group.dispatcher.id
    gateway    = aws_security_group.gateway.id
    session    = aws_security_group.session_task.id
  }
}

resource "aws_vpc_security_group_egress_rule" "workload_to_endpoints" {
  for_each = local.private_workload_security_groups

  security_group_id            = each.value
  referenced_security_group_id = aws_security_group.vpc_endpoints.id
  from_port                    = 443
  ip_protocol                  = "tcp"
  to_port                      = 443
}

resource "aws_vpc_security_group_ingress_rule" "endpoints_from_workload" {
  for_each = local.private_workload_security_groups

  security_group_id            = aws_security_group.vpc_endpoints.id
  referenced_security_group_id = each.value
  from_port                    = 443
  ip_protocol                  = "tcp"
  to_port                      = 443
}

resource "aws_vpc_security_group_ingress_rule" "endpoints_from_proxy" {
  count = var.enable_egress_proxy ? 1 : 0

  security_group_id            = aws_security_group.vpc_endpoints.id
  referenced_security_group_id = aws_security_group.egress_proxy.id
  from_port                    = 443
  ip_protocol                  = "tcp"
  to_port                      = 443
}

resource "aws_vpc_security_group_egress_rule" "workload_to_s3" {
  for_each = local.private_workload_security_groups

  security_group_id = each.value
  prefix_list_id    = aws_vpc_endpoint.s3.prefix_list_id
  from_port         = 443
  ip_protocol       = "tcp"
  to_port           = 443
}

resource "aws_vpc_security_group_egress_rule" "workload_to_proxy" {
  for_each = var.enable_egress_proxy ? local.private_workload_security_groups : {}

  security_group_id            = each.value
  referenced_security_group_id = aws_security_group.egress_proxy_lb.id
  from_port                    = var.egress_proxy_port
  ip_protocol                  = "tcp"
  to_port                      = var.egress_proxy_port
}

resource "aws_vpc_security_group_ingress_rule" "proxy_from_workload" {
  for_each = var.enable_egress_proxy ? local.private_workload_security_groups : {}

  security_group_id            = aws_security_group.egress_proxy_lb.id
  referenced_security_group_id = each.value
  from_port                    = var.egress_proxy_port
  ip_protocol                  = "tcp"
  to_port                      = var.egress_proxy_port
}

resource "aws_vpc_security_group_egress_rule" "proxy_lb_to_tasks" {
  count = var.enable_egress_proxy ? 1 : 0

  security_group_id            = aws_security_group.egress_proxy_lb.id
  referenced_security_group_id = aws_security_group.egress_proxy.id
  from_port                    = var.egress_proxy_port
  ip_protocol                  = "tcp"
  to_port                      = var.egress_proxy_port
}

resource "aws_vpc_security_group_ingress_rule" "proxy_from_lb" {
  count = var.enable_egress_proxy ? 1 : 0

  security_group_id            = aws_security_group.egress_proxy.id
  referenced_security_group_id = aws_security_group.egress_proxy_lb.id
  from_port                    = var.egress_proxy_port
  ip_protocol                  = "tcp"
  to_port                      = var.egress_proxy_port
}

resource "aws_vpc_security_group_egress_rule" "proxy_https" {
  count = var.enable_egress_proxy ? 1 : 0

  security_group_id = aws_security_group.egress_proxy.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  ip_protocol       = "tcp"
  to_port           = 443
}

resource "aws_vpc_endpoint" "interface" {
  for_each = local.interface_endpoint_services

  vpc_id              = aws_vpc.runner.id
  service_name        = "com.amazonaws.${var.aws_region}.${each.value}"
  vpc_endpoint_type   = "Interface"
  private_dns_enabled = true
  subnet_ids          = values(aws_subnet.private)[*].id
  security_group_ids  = [aws_security_group.vpc_endpoints.id]

  tags = { Name = "${local.name}-${replace(each.value, ".", "-")}" }
}

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.runner.id
  service_name      = "com.amazonaws.${var.aws_region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = values(aws_route_table.private)[*].id
  policy            = data.aws_iam_policy_document.s3_endpoint.json

  tags = { Name = "${local.name}-s3" }
}

data "aws_iam_policy_document" "s3_endpoint" {
  statement {
    sid       = "ReadRegionalEcrLayers"
    actions   = ["s3:GetObject"]
    resources = ["arn:${data.aws_partition.current.partition}:s3:::prod-${var.aws_region}-starport-layer-bucket/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }
  }

  statement {
    sid = "ReadOwnedBucketMetadata"
    actions = [
      "s3:GetBucketLocation",
    ]
    resources = [
      local.artifact_bucket.arn,
      local.checkpoint_bucket.arn,
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }
  }

  statement {
    sid     = "ReadOwnedObjects"
    actions = ["s3:GetObject"]
    resources = [
      "${local.artifact_bucket.arn}/*",
      "${local.checkpoint_bucket.arn}/*",
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }
  }

  statement {
    sid       = "WriteOwnedCheckpoints"
    actions   = ["s3:PutObject"]
    resources = ["${local.checkpoint_bucket.arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }
  }
}

resource "aws_ecs_cluster" "runner" {
  name = local.name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_kms_key" "data_protected" {
  count = var.deletion_protection ? 1 : 0

  description             = "KMS key for ${local.name} hosted-runner data"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_key" "data_disposable" {
  count = var.deletion_protection ? 0 : 1

  description             = "KMS key for ${local.name} hosted-runner data"
  deletion_window_in_days = 7
  enable_key_rotation     = true
}

resource "aws_kms_alias" "data" {
  name          = "alias/${local.name}-data"
  target_key_id = local.data_kms_key.key_id
}

resource "aws_kms_key" "service_secrets_protected" {
  count = var.enable_service_secret_boundary && var.deletion_protection ? 1 : 0

  description             = "KMS key for ${local.name} dispatcher service secrets"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.service_secrets_kms[0].json

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_key" "service_secrets_disposable" {
  count = var.enable_service_secret_boundary && !var.deletion_protection ? 1 : 0

  description             = "KMS key for ${local.name} dispatcher service secrets"
  deletion_window_in_days = 7
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.service_secrets_kms[0].json
}

data "aws_iam_policy_document" "service_secrets_kms" {
  count = var.enable_service_secret_boundary ? 1 : 0

  statement {
    sid       = "EnableAccountKeyAdministration"
    effect    = "Allow"
    actions   = ["kms:*"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }

  statement {
    sid       = "DenySecretDecryptionOutsideDispatcherExecution"
    effect    = "Deny"
    actions   = ["kms:Decrypt"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    condition {
      test     = "ArnNotEquals"
      variable = "aws:PrincipalArn"
      values   = [aws_iam_role.dispatcher_execution[0].arn]
    }
  }
}

resource "aws_kms_alias" "service_secrets" {
  count = var.enable_service_secret_boundary ? 1 : 0

  name          = "alias/${local.name}-service-secrets"
  target_key_id = local.service_secrets_kms_key.key_id
}

resource "aws_secretsmanager_secret" "dispatcher_runner_shared_secret_protected" {
  count = var.enable_service_secret_boundary && var.deletion_protection ? 1 : 0

  description             = "Shared dispatcher credential for ${local.name}. Seed and rotate outside Terraform."
  kms_key_id              = local.service_secrets_kms_key.arn
  name                    = "${local.name}/dispatcher/runner-shared-secret"
  recovery_window_in_days = 30

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_secretsmanager_secret" "dispatcher_runner_shared_secret_disposable" {
  count = var.enable_service_secret_boundary && !var.deletion_protection ? 1 : 0

  description                    = "Shared dispatcher credential for ${local.name}. Seed and rotate outside Terraform."
  force_overwrite_replica_secret = false
  kms_key_id                     = local.service_secrets_kms_key.arn
  name                           = "${local.name}/dispatcher/runner-shared-secret"
  recovery_window_in_days        = 7
}

data "aws_iam_policy_document" "dispatcher_runner_shared_secret" {
  count = var.enable_service_secret_boundary ? 1 : 0

  statement {
    sid       = "DenyRetrievalOutsideDispatcherExecution"
    effect    = "Deny"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [local.dispatcher_runner_shared_secret.arn]

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    condition {
      test     = "ArnNotEquals"
      variable = "aws:PrincipalArn"
      values   = [aws_iam_role.dispatcher_execution[0].arn]
    }
  }
}

resource "aws_secretsmanager_secret_policy" "dispatcher_runner_shared_secret" {
  count = var.enable_service_secret_boundary ? 1 : 0

  block_public_policy = true
  policy              = data.aws_iam_policy_document.dispatcher_runner_shared_secret[0].json
  secret_arn          = local.dispatcher_runner_shared_secret.arn
}

resource "aws_ecr_repository" "runner_protected" {
  count = var.deletion_protection ? 1 : 0

  name                 = "${local.name}-runner"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = local.data_kms_key.arn
  }

  lifecycle {
    prevent_destroy = true

    precondition {
      condition     = !contains(["staging", "production"], var.environment) || var.deletion_protection
      error_message = "Persistent environments require deletion_protection=true."
    }
  }
}

resource "aws_ecr_repository" "runner_disposable" {
  count = var.deletion_protection ? 0 : 1

  name                 = "${local.name}-runner"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = var.ecr_force_delete

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = local.data_kms_key.arn
  }
}

resource "aws_ecr_repository" "proxy_protected" {
  count = var.enable_egress_proxy && var.deletion_protection ? 1 : 0

  name                 = "${local.name}-egress-proxy"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = local.data_kms_key.arn
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_ecr_repository" "proxy_disposable" {
  count = var.enable_egress_proxy && !var.deletion_protection ? 1 : 0

  name                 = "${local.name}-egress-proxy"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = var.ecr_force_delete

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = local.data_kms_key.arn
  }
}

resource "aws_ecr_lifecycle_policy" "proxy" {
  count = var.enable_egress_proxy ? 1 : 0

  repository = local.proxy_repository.name
  policy = jsonencode({
    rules = [{
      action       = { type = "expire" }
      description  = "Keep all tagged releases and the newest 20 untagged images"
      rulePriority = 1
      selection = {
        countNumber = 20
        countType   = "imageCountMoreThan"
        tagStatus   = "untagged"
      }
    }]
  })
}

resource "aws_ecr_lifecycle_policy" "runner" {
  repository = local.runner_repository.name
  policy = jsonencode({
    rules = [{
      action       = { type = "expire" }
      description  = "Keep all tagged releases and the newest 20 untagged images"
      rulePriority = 1
      selection = {
        countNumber = 20
        countType   = "imageCountMoreThan"
        tagStatus   = "untagged"
      }
    }]
  })
}

resource "aws_s3_bucket" "artifacts_protected" {
  count  = var.deletion_protection ? 1 : 0
  bucket = "${local.bucket_prefix}-a"

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket" "artifacts_disposable" {
  count         = var.deletion_protection ? 0 : 1
  bucket        = "${local.bucket_prefix}-a"
  force_destroy = true
}

resource "aws_s3_bucket" "checkpoints_protected" {
  count  = var.deletion_protection ? 1 : 0
  bucket = "${local.bucket_prefix}-c"

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket" "checkpoints_disposable" {
  count         = var.deletion_protection ? 0 : 1
  bucket        = "${local.bucket_prefix}-c"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket = local.artifact_bucket.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_public_access_block" "checkpoints" {
  bucket = local.checkpoint_bucket.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

data "aws_iam_policy_document" "artifacts_bucket" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      local.artifact_bucket.arn,
      "${local.artifact_bucket.arn}/*",
    ]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  statement {
    sid       = "DenyExplicitNonKmsEncryption"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${local.artifact_bucket.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Null"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["false"]
    }
    condition {
      test     = "StringNotEquals"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["aws:kms"]
    }
  }

  statement {
    sid       = "DenyExplicitWrongKmsKey"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${local.artifact_bucket.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Null"
      variable = "s3:x-amz-server-side-encryption-aws-kms-key-id"
      values   = ["false"]
    }
    condition {
      test     = "StringNotEquals"
      variable = "s3:x-amz-server-side-encryption-aws-kms-key-id"
      values   = [local.data_kms_key.arn, local.data_kms_key.key_id]
    }
  }

  statement {
    sid       = "DenyExplicitKmsWithoutKey"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${local.artifact_bucket.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["aws:kms"]
    }
    condition {
      test     = "Null"
      variable = "s3:x-amz-server-side-encryption-aws-kms-key-id"
      values   = ["true"]
    }
  }
}

resource "aws_s3_bucket_policy" "artifacts" {
  bucket = local.artifact_bucket.id
  policy = data.aws_iam_policy_document.artifacts_bucket.json
}

data "aws_iam_policy_document" "checkpoints_bucket" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      local.checkpoint_bucket.arn,
      "${local.checkpoint_bucket.arn}/*",
    ]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  statement {
    sid       = "DenyExplicitNonKmsEncryption"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${local.checkpoint_bucket.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Null"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["false"]
    }
    condition {
      test     = "StringNotEquals"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["aws:kms"]
    }
  }

  statement {
    sid       = "DenyExplicitWrongKmsKey"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${local.checkpoint_bucket.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Null"
      variable = "s3:x-amz-server-side-encryption-aws-kms-key-id"
      values   = ["false"]
    }
    condition {
      test     = "StringNotEquals"
      variable = "s3:x-amz-server-side-encryption-aws-kms-key-id"
      values   = [local.data_kms_key.arn, local.data_kms_key.key_id]
    }
  }

  statement {
    sid       = "DenyExplicitKmsWithoutKey"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${local.checkpoint_bucket.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["aws:kms"]
    }
    condition {
      test     = "Null"
      variable = "s3:x-amz-server-side-encryption-aws-kms-key-id"
      values   = ["true"]
    }
  }
}

resource "aws_s3_bucket_policy" "checkpoints" {
  bucket = local.checkpoint_bucket.id
  policy = data.aws_iam_policy_document.checkpoints_bucket.json
}

resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {
  bucket = local.artifact_bucket.id

  rule {
    bucket_key_enabled = true
    apply_server_side_encryption_by_default {
      kms_master_key_id = local.data_kms_key.arn
      sse_algorithm     = "aws:kms"
    }
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "checkpoints" {
  bucket = local.checkpoint_bucket.id

  rule {
    bucket_key_enabled = true
    apply_server_side_encryption_by_default {
      kms_master_key_id = local.data_kms_key.arn
      sse_algorithm     = "aws:kms"
    }
  }
}

resource "aws_s3_bucket_versioning" "artifacts" {
  bucket = local.artifact_bucket.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_lifecycle_configuration" "checkpoints" {
  bucket = local.checkpoint_bucket.id

  rule {
    id     = "expire-session-checkpoints"
    status = "Enabled"
    filter {}

    expiration { days = var.checkpoint_retention_days }
    abort_incomplete_multipart_upload { days_after_initiation = 1 }
  }
}

resource "aws_cloudwatch_log_group" "runner" {
  name              = "/${var.project_name}/${var.environment}/runner"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "ttl_cleanup" {
  name              = "/aws/lambda/${local.name}-ttl-cleanup"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_metric_filter" "ttl_malformed" {
  name           = "${local.name}-ttl-malformed"
  log_group_name = aws_cloudwatch_log_group.ttl_cleanup.name
  pattern        = "\"Managed tasks have invalid TTL tags\""

  metric_transformation {
    name      = "MalformedManagedTaskTtl"
    namespace = "LearningLab/${var.environment}"
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "ttl_cleanup_errors" {
  alarm_name          = "${local.name}-ttl-cleanup-errors"
  alarm_description   = "The hosted session TTL cleanup Lambda returned an error."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 60
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.enable_security_observability ? [var.security_alarm_topic_arn] : []

  dimensions = {
    FunctionName = aws_lambda_function.ttl_cleanup.function_name
  }
}

data "aws_iam_policy_document" "ecs_task_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "task_execution" {
  name               = "${local.name}-task-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume.json
}

data "aws_iam_policy_document" "task_execution" {
  statement {
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = concat(
      [
        local.runner_repository.arn,
        "arn:${data.aws_partition.current.partition}:ecr:${var.aws_region}:*:repository/aws-guardduty-agent-fargate",
      ],
      var.enable_egress_proxy ? [local.proxy_repository.arn] : [],
    )
  }

  statement {
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.runner.arn}:*"]
  }
}

resource "aws_iam_role_policy" "task_execution" {
  name   = "runner-image-and-logs"
  role   = aws_iam_role.task_execution.id
  policy = data.aws_iam_policy_document.task_execution.json
}

resource "aws_iam_role" "dispatcher_execution" {
  count = var.enable_service_secret_boundary ? 1 : 0

  name               = "${local.name}-dispatcher-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume.json
}

data "aws_iam_policy_document" "dispatcher_execution" {
  count = var.enable_service_secret_boundary ? 1 : 0

  statement {
    sid       = "ReadRunnerSharedSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [local.dispatcher_runner_shared_secret.arn]
  }

  statement {
    sid       = "DecryptRunnerSharedSecret"
    actions   = ["kms:Decrypt"]
    resources = [local.service_secrets_kms_key.arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${var.aws_region}.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:EncryptionContext:SecretARN"
      values   = [local.dispatcher_runner_shared_secret.arn]
    }
  }
}

resource "aws_iam_role_policy" "dispatcher_execution" {
  count = var.enable_service_secret_boundary ? 1 : 0

  name   = "runner-shared-secret-startup"
  role   = aws_iam_role.dispatcher_execution[0].id
  policy = data.aws_iam_policy_document.dispatcher_execution[0].json
}

resource "aws_iam_role" "dispatcher_task" {
  count = var.enable_service_secret_boundary ? 1 : 0

  name               = "${local.name}-dispatcher-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume.json
}

data "aws_iam_policy_document" "dispatcher_task" {
  count = var.enable_service_secret_boundary ? 1 : 0

  statement {
    sid       = "RunLearnerTasks"
    actions   = ["ecs:RunTask"]
    resources = ["${aws_ecs_task_definition.runner.arn_without_revision}:*"]

    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.runner.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/learning-lab:managed"
      values   = ["true"]
    }

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values = [
        "learning-lab:expires-at",
        "learning-lab:lab-slug",
        "learning-lab:managed",
        "learning-lab:session-id",
      ]
    }
  }

  statement {
    sid = "ManageLearnerTasks"
    actions = [
      "ecs:DescribeTasks",
      "ecs:StopTask",
    ]
    resources = ["arn:${data.aws_partition.current.partition}:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:task/${aws_ecs_cluster.runner.name}/*"]

    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.runner.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/learning-lab:managed"
      values   = ["true"]
    }
  }

  statement {
    sid       = "TagLearnerTasksOnCreate"
    actions   = ["ecs:TagResource"]
    resources = ["arn:${data.aws_partition.current.partition}:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:task/${aws_ecs_cluster.runner.name}/*"]

    condition {
      test     = "StringEquals"
      variable = "ecs:CreateAction"
      values   = ["RunTask"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/learning-lab:managed"
      values   = ["true"]
    }

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values = [
        "learning-lab:expires-at",
        "learning-lab:lab-slug",
        "learning-lab:managed",
        "learning-lab:session-id",
      ]
    }
  }

  statement {
    sid       = "ListLearnerTasks"
    actions   = ["ecs:ListTasks"]
    resources = ["*"]

    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.runner.arn]
    }
  }

  statement {
    sid     = "PassLearnerRoles"
    actions = ["iam:PassRole"]
    resources = concat(
      [aws_iam_role.task_execution.arn],
      var.enable_learner_metadata_boundary ? [] : [aws_iam_role.task.arn],
    )

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "dispatcher_task" {
  count = var.enable_service_secret_boundary ? 1 : 0

  name   = "learner-task-lifecycle"
  role   = aws_iam_role.dispatcher_task[0].id
  policy = data.aws_iam_policy_document.dispatcher_task[0].json
}

resource "aws_iam_role" "task" {
  name               = "${local.name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume.json
}

resource "aws_ecs_task_definition" "runner" {
  family                   = "${local.name}-runner"
  cpu                      = tostring(var.runner_cpu)
  memory                   = tostring(var.runner_memory)
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = var.enable_learner_metadata_boundary ? null : aws_iam_role.task.arn

  depends_on = [
    aws_iam_role_policy.task_execution,
  ]

  runtime_platform {
    cpu_architecture        = var.runner_cpu_architecture
    operating_system_family = "LINUX"
  }

  ephemeral_storage { size_in_gib = var.runner_ephemeral_storage_gib }

  container_definitions = var.enable_learner_metadata_boundary ? jsonencode([
    merge(
      local.runner_container_definition,
      {
        user    = "1000:1000"
        command = var.runner_command
        entryPoint = [
          "/usr/bin/env",
          "-u", "AWS_CONTAINER_AUTHORIZATION_TOKEN",
          "-u", "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
          "-u", "AWS_CONTAINER_CREDENTIALS_FULL_URI",
          "-u", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
          "-u", "ECS_AGENT_URI",
          "-u", "ECS_CONTAINER_METADATA_URI",
          "-u", "ECS_CONTAINER_METADATA_URI_V4",
        ]
        linuxParameters = {
          capabilities = {
            add  = []
            drop = ["ALL"]
          }
        }
      },
    )
  ]) : jsonencode([local.runner_container_definition])
}

resource "aws_iam_role" "egress_proxy_task" {
  count = var.enable_egress_proxy ? 1 : 0

  name               = "${local.name}-egress-proxy-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume.json
}

resource "aws_ecs_task_definition" "egress_proxy" {
  count = var.enable_egress_proxy ? 1 : 0

  family                   = "${local.name}-egress-proxy"
  cpu                      = "256"
  memory                   = "512"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.egress_proxy_task[0].arn

  depends_on = [aws_iam_role_policy.task_execution]

  runtime_platform {
    cpu_architecture        = var.runner_cpu_architecture
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([{
    name      = "egress-proxy"
    image     = var.egress_proxy_image_uri
    essential = true
    linuxParameters = {
      capabilities = {
        add  = []
        drop = ["ALL"]
      }
      initProcessEnabled = true
    }
    portMappings = [{
      containerPort = var.egress_proxy_port
      hostPort      = var.egress_proxy_port
      protocol      = "tcp"
    }]
    healthCheck = {
      command     = ["CMD-SHELL", "squidclient -h 127.0.0.1 -p ${var.egress_proxy_port} mgr:info >/dev/null 2>&1 || exit 1"]
      interval    = 30
      retries     = 3
      startPeriod = 20
      timeout     = 5
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.runner.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "egress-proxy"
      }
    }
  }])
}

resource "aws_ecs_service" "egress_proxy" {
  count = var.enable_egress_proxy ? 1 : 0

  name            = "${local.name}-egress-proxy"
  cluster         = aws_ecs_cluster.runner.id
  task_definition = aws_ecs_task_definition.egress_proxy[0].arn
  desired_count   = 2
  launch_type     = "FARGATE"

  depends_on = [aws_lb_listener.egress_proxy]

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  load_balancer {
    container_name   = "egress-proxy"
    container_port   = var.egress_proxy_port
    target_group_arn = aws_lb_target_group.egress_proxy[0].arn
  }

  network_configuration {
    assign_public_ip = false
    security_groups  = [aws_security_group.egress_proxy.id]
    subnets          = values(aws_subnet.private)[*].id
  }
}

resource "aws_lb" "egress_proxy" {
  count = var.enable_egress_proxy ? 1 : 0

  name               = substr("${local.name}-proxy", 0, 32)
  internal           = true
  load_balancer_type = "network"
  security_groups    = [aws_security_group.egress_proxy_lb.id]
  subnets            = values(aws_subnet.private)[*].id

  enable_cross_zone_load_balancing = true

  enable_deletion_protection = var.deletion_protection

  tags = { Name = "${local.name}-egress-proxy" }
}

resource "aws_lb_target_group" "egress_proxy" {
  count = var.enable_egress_proxy ? 1 : 0

  name        = substr("${local.name}-proxy", 0, 32)
  port        = var.egress_proxy_port
  protocol    = "TCP"
  target_type = "ip"
  vpc_id      = aws_vpc.runner.id

  health_check {
    enabled  = true
    protocol = "TCP"
  }
}

resource "aws_lb_listener" "egress_proxy" {
  count = var.enable_egress_proxy ? 1 : 0

  load_balancer_arn = aws_lb.egress_proxy[0].arn
  port              = var.egress_proxy_port
  protocol          = "TCP"

  default_action {
    target_group_arn = aws_lb_target_group.egress_proxy[0].arn
    type             = "forward"
  }
}

data "archive_file" "ttl_cleanup" {
  type        = "zip"
  source_file = "${path.module}/lambda/index.cjs"
  output_path = "${path.root}/.terraform/ttl-cleanup.zip"
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ttl_cleanup" {
  name               = "${local.name}-ttl-cleanup"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "ttl_cleanup" {
  statement {
    actions   = ["ecs:ListTasks", "ecs:DescribeTasks"]
    resources = ["*"]
  }

  statement {
    actions   = ["ecs:StopTask"]
    resources = ["arn:aws:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:task/${aws_ecs_cluster.runner.name}/*"]
  }

  statement {
    actions = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = [
      "${aws_cloudwatch_log_group.ttl_cleanup.arn}:*"
    ]
  }
}

resource "aws_iam_role_policy" "ttl_cleanup" {
  name   = "ttl-cleanup"
  role   = aws_iam_role.ttl_cleanup.id
  policy = data.aws_iam_policy_document.ttl_cleanup.json
}

resource "aws_lambda_function" "ttl_cleanup" {
  filename         = data.archive_file.ttl_cleanup.output_path
  function_name    = "${local.name}-ttl-cleanup"
  handler          = "index.handler"
  role             = aws_iam_role.ttl_cleanup.arn
  runtime          = "nodejs22.x"
  source_code_hash = data.archive_file.ttl_cleanup.output_base64sha256
  timeout          = 60

  depends_on = [aws_iam_role_policy.ttl_cleanup]

  environment {
    variables = {
      ECS_CLUSTER_ARN             = aws_ecs_cluster.runner.arn
      MAX_MANAGED_RUNTIME_SECONDS = tostring(var.ttl_max_managed_runtime_seconds)
    }
  }
}

resource "aws_cloudwatch_event_rule" "ttl_cleanup" {
  name                = "${local.name}-ttl-cleanup"
  schedule_expression = var.ttl_cleanup_schedule
}

resource "aws_cloudwatch_event_target" "ttl_cleanup" {
  arn  = aws_lambda_function.ttl_cleanup.arn
  rule = aws_cloudwatch_event_rule.ttl_cleanup.name
}

resource "aws_lambda_permission" "ttl_cleanup" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ttl_cleanup.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.ttl_cleanup.arn
}
