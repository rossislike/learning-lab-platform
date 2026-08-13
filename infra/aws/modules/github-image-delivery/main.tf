data "aws_partition" "current" {}

locals {
  oidc_host = "token.actions.githubusercontent.com"
}

resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://${local.oidc_host}"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = var.github_oidc_thumbprints
}

data "aws_iam_policy_document" "delivery_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
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
}

resource "aws_iam_role_policy" "delivery" {
  name   = "publish-hosted-image-digests"
  role   = aws_iam_role.delivery.id
  policy = data.aws_iam_policy_document.delivery.json
}

data "aws_iam_policy_document" "promotion_reader_assume" {
  count = var.create_production_promotion_reader ? 1 : 0

  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:sub"
      values   = ["repo:${var.github_repository}:environment:production"]
    }
  }
}

resource "aws_iam_role" "promotion_reader" {
  count = var.create_production_promotion_reader ? 1 : 0

  name                 = "learning-lab-platform-staging-promotion-reader"
  assume_role_policy   = data.aws_iam_policy_document.promotion_reader_assume[0].json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "promotion_reader" {
  count = var.create_production_promotion_reader ? 1 : 0

  statement {
    sid       = "AuthenticateToEcr"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid = "ReadStagingDigests"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:DescribeImages",
      "ecr:GetDownloadUrlForLayer",
      "ecr:ListImages",
    ]
    resources = var.ecr_repository_arns
  }
}

resource "aws_iam_role_policy" "promotion_reader" {
  count = var.create_production_promotion_reader ? 1 : 0

  name   = "read-staging-image-digests"
  role   = aws_iam_role.promotion_reader[0].id
  policy = data.aws_iam_policy_document.promotion_reader[0].json
}
