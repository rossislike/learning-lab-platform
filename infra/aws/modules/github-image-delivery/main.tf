data "aws_partition" "current" {}

locals {
  oidc_host = "token.actions.githubusercontent.com"
}

data "aws_iam_policy_document" "delivery_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [var.github_oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:sub"
      values   = ["repo:${var.github_repository}:environment:${var.environment}"]
    }
  }
}

resource "aws_iam_role" "delivery" {
  name                 = "learning-lab-platform-${var.environment}-image-delivery"
  assume_role_policy   = data.aws_iam_policy_document.delivery_assume.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "delivery" {
  statement {
    sid       = "AuthenticateToEcr"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid = "PublishHostedImages"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:CompleteLayerUpload",
      "ecr:DescribeImages",
      "ecr:GetDownloadUrlForLayer",
      "ecr:InitiateLayerUpload",
      "ecr:ListImages",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
    ]
    resources = var.ecr_repository_arns
  }

  dynamic "statement" {
    for_each = length(var.promotion_source_ecr_repository_arns) > 0 ? [true] : []

    content {
      sid = "ReadStagingPromotionSources"
      actions = [
        "ecr:BatchCheckLayerAvailability",
        "ecr:BatchGetImage",
        "ecr:DescribeImages",
        "ecr:GetDownloadUrlForLayer",
        "ecr:ListImages",
      ]
      resources = var.promotion_source_ecr_repository_arns
    }
  }
}

resource "aws_iam_role_policy" "delivery" {
  name   = "publish-hosted-image-digests"
  role   = aws_iam_role.delivery.id
  policy = data.aws_iam_policy_document.delivery.json
}

check "promotion_sources_are_production_only" {
  assert {
    condition = var.environment == "production" ? (
      length(var.promotion_source_ecr_repository_arns) > 0
      ) : (
      length(var.promotion_source_ecr_repository_arns) == 0
    )
    error_message = "Production must receive staging promotion source repositories; staging must not receive cross-environment repository access."
  }
}
