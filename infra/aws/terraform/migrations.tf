# Preserve resource identity when existing validation state adopts the module.
moved {
  from = aws_vpc.runner
  to   = module.hosted_runner.aws_vpc.runner
}
moved {
  from = aws_internet_gateway.runner
  to   = module.hosted_runner.aws_internet_gateway.runner
}
moved {
  from = aws_subnet.public
  to   = module.hosted_runner.aws_subnet.public
}
moved {
  from = aws_subnet.private
  to   = module.hosted_runner.aws_subnet.private
}
moved {
  from = aws_route_table.public
  to   = module.hosted_runner.aws_route_table.public
}
moved {
  from = aws_route.public_internet
  to   = module.hosted_runner.aws_route.public_internet
}
moved {
  from = aws_route_table_association.public
  to   = module.hosted_runner.aws_route_table_association.public
}
moved {
  from = aws_eip.nat
  to   = module.hosted_runner.aws_eip.nat
}
moved {
  from = aws_nat_gateway.runner
  to   = module.hosted_runner.aws_nat_gateway.runner
}
moved {
  from = aws_route_table.private
  to   = module.hosted_runner.aws_route_table.private
}
moved {
  from = aws_route.private_internet
  to   = module.hosted_runner.aws_route.private_internet
}
moved {
  from = aws_route_table_association.private
  to   = module.hosted_runner.aws_route_table_association.private
}
moved {
  from = aws_security_group.session_task
  to   = module.hosted_runner.aws_security_group.session_task
}
moved {
  from = aws_ecs_cluster.runner
  to   = module.hosted_runner.aws_ecs_cluster.runner
}
moved {
  from = aws_ecr_repository.runner
  to   = module.hosted_runner.aws_ecr_repository.runner_disposable[0]
}
moved {
  from = aws_ecr_lifecycle_policy.runner
  to   = module.hosted_runner.aws_ecr_lifecycle_policy.runner
}
moved {
  from = aws_s3_bucket.artifacts
  to   = module.hosted_runner.aws_s3_bucket.artifacts_disposable[0]
}
moved {
  from = aws_s3_bucket.checkpoints
  to   = module.hosted_runner.aws_s3_bucket.checkpoints_disposable[0]
}
moved {
  from = aws_s3_bucket_public_access_block.artifacts
  to   = module.hosted_runner.aws_s3_bucket_public_access_block.artifacts
}
moved {
  from = aws_s3_bucket_public_access_block.checkpoints
  to   = module.hosted_runner.aws_s3_bucket_public_access_block.checkpoints
}
moved {
  from = aws_s3_bucket_policy.artifacts
  to   = module.hosted_runner.aws_s3_bucket_policy.artifacts
}
moved {
  from = aws_s3_bucket_policy.checkpoints
  to   = module.hosted_runner.aws_s3_bucket_policy.checkpoints
}
moved {
  from = aws_s3_bucket_server_side_encryption_configuration.artifacts
  to   = module.hosted_runner.aws_s3_bucket_server_side_encryption_configuration.artifacts
}
moved {
  from = aws_s3_bucket_server_side_encryption_configuration.checkpoints
  to   = module.hosted_runner.aws_s3_bucket_server_side_encryption_configuration.checkpoints
}
moved {
  from = aws_s3_bucket_versioning.artifacts
  to   = module.hosted_runner.aws_s3_bucket_versioning.artifacts
}
moved {
  from = aws_s3_bucket_lifecycle_configuration.checkpoints
  to   = module.hosted_runner.aws_s3_bucket_lifecycle_configuration.checkpoints
}
moved {
  from = aws_cloudwatch_log_group.runner
  to   = module.hosted_runner.aws_cloudwatch_log_group.runner
}
moved {
  from = aws_cloudwatch_log_group.ttl_cleanup
  to   = module.hosted_runner.aws_cloudwatch_log_group.ttl_cleanup
}
moved {
  from = aws_cloudwatch_log_metric_filter.ttl_malformed
  to   = module.hosted_runner.aws_cloudwatch_log_metric_filter.ttl_malformed
}
moved {
  from = aws_cloudwatch_metric_alarm.ttl_cleanup_errors
  to   = module.hosted_runner.aws_cloudwatch_metric_alarm.ttl_cleanup_errors
}
moved {
  from = aws_iam_role.task_execution
  to   = module.hosted_runner.aws_iam_role.task_execution
}
moved {
  from = aws_iam_role_policy.task_execution
  to   = module.hosted_runner.aws_iam_role_policy.task_execution
}
moved {
  from = aws_iam_role.task
  to   = module.hosted_runner.aws_iam_role.task
}
moved {
  from = aws_ecs_task_definition.runner
  to   = module.hosted_runner.aws_ecs_task_definition.runner
}
moved {
  from = aws_iam_role.ttl_cleanup
  to   = module.hosted_runner.aws_iam_role.ttl_cleanup
}
moved {
  from = aws_iam_role_policy.ttl_cleanup
  to   = module.hosted_runner.aws_iam_role_policy.ttl_cleanup
}
moved {
  from = aws_lambda_function.ttl_cleanup
  to   = module.hosted_runner.aws_lambda_function.ttl_cleanup
}
moved {
  from = aws_cloudwatch_event_rule.ttl_cleanup
  to   = module.hosted_runner.aws_cloudwatch_event_rule.ttl_cleanup
}
moved {
  from = aws_cloudwatch_event_target.ttl_cleanup
  to   = module.hosted_runner.aws_cloudwatch_event_target.ttl_cleanup
}
moved {
  from = aws_lambda_permission.ttl_cleanup
  to   = module.hosted_runner.aws_lambda_permission.ttl_cleanup
}
