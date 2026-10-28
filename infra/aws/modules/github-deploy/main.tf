# GitHub Actions deploy role for the dev environment (ROADMAP Phase 6): what
# scripts/deploy-dev.mjs needs, scoped to this environment's resources, and
# assumable only by jobs running in the repository's `dev` GitHub environment
# (OIDC subject `repo:<owner/name>:environment:dev`) through the account-level
# OIDC provider that account-security created. A job that names an
# environment always gets the environment subject, never the branch one, so
# the branch gate is the environment's deployment-branch rule (main only) —
# a REQUIRED repository setting (docs/dev-environment.md).

data "aws_partition" "current" {}
data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

locals {
  oidc_host = "token.actions.githubusercontent.com"
}

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [data.aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:sub"
      values   = ["repo:${var.github_repository}:environment:${var.github_environment}"]
    }
  }
}

resource "aws_iam_role" "deploy" {
  name                 = "${var.name}-github-deploy"
  assume_role_policy   = data.aws_iam_policy_document.assume.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "deploy" {
  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid = "EcrPush"
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

  # terraform output -json: read the dev state (never write it; infra applies stay manual).
  statement {
    sid       = "ReadTerraformState"
    actions   = ["s3:GetObject", "s3:GetObjectVersion"]
    resources = ["arn:${data.aws_partition.current.partition}:s3:::${var.terraform_state_bucket}/${var.terraform_state_key}"]
  }

  statement {
    sid       = "ListTerraformState"
    actions   = ["s3:ListBucket"]
    resources = ["arn:${data.aws_partition.current.partition}:s3:::${var.terraform_state_bucket}"]
  }

  statement {
    sid       = "DecryptTerraformState"
    actions   = ["kms:Decrypt", "kms:DescribeKey"]
    resources = [var.terraform_state_kms_key_arn]
  }

  statement {
    sid       = "PublishBundles"
    actions   = ["s3:PutObject", "s3:GetObject"]
    resources = ["${var.bundles_bucket_arn}/scenarios/*"]
  }

  statement {
    sid       = "SyncFrontend"
    actions   = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"]
    resources = ["${var.frontend_bucket_arn}/*"]
  }

  statement {
    sid       = "ListBuckets"
    actions   = ["s3:ListBucket"]
    resources = [var.bundles_bucket_arn, var.frontend_bucket_arn]
  }

  statement {
    sid       = "InvalidateFrontend"
    actions   = ["cloudfront:CreateInvalidation"]
    resources = [var.cloudfront_distribution_arn]
  }

  statement {
    sid       = "GatewayDns"
    actions   = ["route53:ChangeResourceRecordSets", "route53:ListResourceRecordSets"]
    resources = ["arn:${data.aws_partition.current.partition}:route53:::hostedzone/${var.dns_zone_id}"]
  }

  statement {
    sid       = "DnsChangeStatus"
    actions   = ["route53:GetChange"]
    resources = ["arn:${data.aws_partition.current.partition}:route53:::change/*"]
  }

  statement {
    sid       = "ClusterAccess"
    actions   = ["eks:DescribeCluster"]
    resources = [var.cluster_arn]
  }

  statement {
    sid       = "DescribeLoadBalancers"
    actions   = ["elasticloadbalancing:DescribeLoadBalancers"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "deploy" {
  name   = "deploy-dev"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy.json
}
