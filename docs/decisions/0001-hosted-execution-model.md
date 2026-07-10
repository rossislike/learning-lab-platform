# ADR 0001: Hosted Execution Model

- Status: Accepted
- Date: 2026-07-09
- Decision owners: Learning Lab Platform maintainers

## Context

The first hosted workload is an interactive React lab with these properties:

- One disposable workspace belongs to one learner session.
- A session runs an editor, Vite preview, tools endpoint, and validation process.
- Convex remains the durable control plane for session state and events.
- The workspace has a bounded TTL and must be removed after stop or expiry.
- The workload does not require a Kubernetes API, a Docker daemon, privileged containers, host access, GPUs, or virtual machines.

The platform needs a model that isolates learner sessions, scales without managing a worker fleet, provides explicit CPU and memory limits, and maps directly to the existing `start`, `check`, and `stop` runner lifecycle.

## Decision

Use Amazon ECS with the AWS Fargate launch type for the first hosted execution model.

Each learner session runs as one ECS standalone task. The task is not managed by an ECS service because stopping or completing a session must not cause ECS to replace it. The existing AWS dispatcher calls `RunTask` when Convex contains a requested `aws-ecs-fargate` session and calls `StopTask` during cleanup.

The first task definition will use one Linux runner container. That container will:

1. Materialize the scenario workspace.
2. Start OpenVSCode, the Vite preview, and the tools endpoint under a process supervisor.
3. Publish workspace URLs and the running state to Convex.
4. Execute validation when the tools endpoint receives a check request.
5. Exit cleanly when the session is stopped or its TTL expires.

One container keeps the editor, preview, validation process, and workspace filesystem in the same failure and cleanup boundary. Separate containers can be introduced later if a concrete isolation or independent deployment requirement appears.

Tasks will use `awsvpc` networking in private subnets. The exact ingress and URL routing design is intentionally deferred to the routing decision. The exact workspace volume and persistence behavior is intentionally deferred to the storage decision.

Task CPU, memory, and ephemeral storage will be explicit and configurable in infrastructure code. Initial values will be selected from measurements of the hosted React scenario instead of being fixed in this decision.

## Why ECS And Fargate

- ECS provides the required task lifecycle without introducing a Kubernetes control plane or Kubernetes release operations.
- Fargate removes EC2 fleet provisioning and scaling from the first hosted release.
- Fargate gives each task dedicated infrastructure capacity and does not share network interfaces, ephemeral storage, CPU, or memory across tasks.
- Standalone tasks match disposable session semantics. ECS services are designed to maintain a desired number of long-running tasks and would replace a session task after it stops.
- Each Fargate task receives its own network interface, which gives the later routing and security work a per-session network identity.

## Alternatives Considered

### Amazon EKS

Do not use EKS for the first hosted React labs. The current workload does not consume Kubernetes APIs or require Kubernetes-native scheduling. EKS would add cluster upgrades, Kubernetes policy, workload identity, and platform operations without enabling a current requirement.

Reconsider EKS when one or more of these conditions becomes true:

- A supported lab must expose a real Kubernetes API to the learner.
- Scenarios require Kubernetes-native resources, controllers, operators, or multi-pod behavior that cannot be simulated accurately.
- The organization standardizes on an existing EKS platform with established operations and security controls.

### ECS On EC2

Do not manage ECS container instances for the first release. Reconsider ECS on EC2 when required workloads need capabilities Fargate does not provide, or when measured steady utilization shows that a managed worker fleet has a material operational or cost advantage.

### EKS With KubeVirt Or Another VM Platform

Do not introduce a virtual machine orchestration layer for browser-based React labs. Reconsider a VM-backed model only when scenarios require a guest kernel, operating system boot process, nested infrastructure, or isolation that cannot be provided by the selected container runtime.

### AWS Lambda Or AWS App Runner

Do not use Lambda because a learner workspace is interactive and session-lived rather than a short request handler. Do not use App Runner because the platform needs explicit one-task-per-session lifecycle control and three session endpoints rather than a continuously deployed web service.

## Consequences

- The initial task image cannot depend on privileged containers or Docker-in-Docker because Fargate does not support privileged mode.
- Kubernetes and virtual machine labs remain a separate execution tier instead of complicating the first React runner.
- Workspace storage, URL routing, secure access, TTL enforcement, and infrastructure definitions remain required follow-up decisions and implementation tasks.
- The runner must detect tasks that stop before publishing a running state and record a useful Convex error event.
- The task definition and application image become versioned deployment artifacts.

## References

- [AWS guide for choosing a container service](https://docs.aws.amazon.com/decision-guides/latest/containers-on-aws-how-to-choose/choosing-aws-container-service.html)
- [Amazon ECS scheduling options](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/scheduling_tasks.html)
- [Amazon ECS standalone tasks](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/standalone-tasks.html)
- [Fargate task networking](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-task-networking.html)
- [Fargate security considerations](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-security-considerations.html)
- [Fargate task definition differences](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-tasks-services.html)
