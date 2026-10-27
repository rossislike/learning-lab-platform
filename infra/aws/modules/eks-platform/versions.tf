terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
      # aws.us_east_1 issues the CloudFront certificate (CloudFront only
      # accepts ACM certificates from us-east-1).
      configuration_aliases = [aws.us_east_1]
    }
  }
}
