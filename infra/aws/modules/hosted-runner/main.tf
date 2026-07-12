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
  runner_repository = var.deletion_protection ? aws_ecr_repository.runner_protected[0] : aws_ecr_repository.runner_disposable[0]

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

  egress {
    from_port   = 0
    protocol    = "-1"
    to_port     = 0
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name}-session-task" }
}

resource "aws_ecs_cluster" "runner" {
  name = local.name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
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
    encryption_type = "AES256"
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
    encryption_type = "AES256"
  }
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
}

resource "aws_s3_bucket_policy" "checkpoints" {
  bucket = local.checkpoint_bucket.id
  policy = data.aws_iam_policy_document.checkpoints_bucket.json
}

resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {
  bucket = local.artifact_bucket.id

  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "checkpoints" {
  bucket = local.checkpoint_bucket.id

  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
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
    resources = [
      local.runner_repository.arn,
      "arn:${data.aws_partition.current.partition}:ecr:${var.aws_region}:*:repository/aws-guardduty-agent-fargate",
    ]
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
  task_role_arn            = aws_iam_role.task.arn

  depends_on = [
    aws_iam_role_policy.task_execution,
  ]

  runtime_platform {
    cpu_architecture        = var.runner_cpu_architecture
    operating_system_family = "LINUX"
  }

  ephemeral_storage { size_in_gib = var.runner_ephemeral_storage_gib }

  container_definitions = jsonencode([{
    name      = "learning-lab-runner"
    image     = var.runner_image_uri
    essential = true
    environment = [
      { name = "LAB_RUNNER_MODE", value = "aws-ecs-fargate" },
      { name = "AWS_REGION", value = var.aws_region }
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.runner.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "ecs"
      }
    }
  }])
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
