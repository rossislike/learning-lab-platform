# Hosted AWS scenario and infrastructure validation

## Result

The complete `react-welcome-message` scenario and the independent TTL cleanup path were validated successfully inside Fargate in AWS account `442359104502`, region `us-east-2`, on 2026-07-10. The scenario validation covered the starter, dependency installation, expected failing check, solution application, and passing check. It did not claim to validate a future public learner gateway.

## Environment

- ECS cluster: `learning-lab-platform-validation`
- Task definition: `learning-lab-platform-validation-runner:2`
- Compute: Fargate, ARM64, 1 vCPU, 2 GiB memory, 21 GiB ephemeral storage
- Networking: private subnets in `us-east-2a` and `us-east-2b`, no public task IP
- Image digest: `sha256:c41aa11a664c9b5599dbefe2c2134be8a9dce48a8fd3da8084afd75dd2ca221c`

## React scenario

The final `react-welcome-message` verification ran as ECS task `91765a7f59584be08eaba94069e2a5eb`. Both the learning lab container and the GuardDuty Runtime Monitoring sidecar exited with code 0. CloudWatch Logs recorded this sequence:

1. Copied the starter project.
2. Installed its dependencies.
3. Confirmed the starter check failed as expected.
4. Applied the solution.
5. Confirmed the solution check passed.
6. Completed one scenario.

This exercises the same scenario smoke script used locally, but inside the deployed Fargate network, execution role, task role, task definition, ECR image, and CloudWatch logging path.

This validates the scenario execution boundary end to end inside hosted compute. The broader learner-facing gateway, editor, preview, checkpoint recovery, and browser authorization design remains future platform implementation and was not part of this scenario validation.

The final run also verified that the scoped task execution role can pull both the project image and the AWS-managed GuardDuty sidecar image, then write only to the configured runner log group.

## TTL cleanup

An intentionally long-running ECS task, `08e45076b5874590939613e334f5f92a`, was tagged as managed with an expiry in the past. The EventBridge schedule invoked the final bundled cleanup Lambda. ECS stopped the task with `UserInitiated` and this reason:

```text
Learning Lab TTL expired at 2026-07-09T00:00:00.000Z
```

The task exited with code 137 after the cleanup request. This verifies the hosted safety net independently of the application dispatcher's normal stop behavior.
