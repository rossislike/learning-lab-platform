# ADR 0005: Kubernetes Execution Model (Local kind, AWS EKS)

- Status: Accepted; amended 2026-10-24 (Phase 2): the preview is not proxied through the agent port — the gateway routes it to the pod's `react.previewPort` on a separate hostname (see ADR 0003's amendment and ADR 0004). Amended 2026-10-25 (Phase 3, as built): no headless Service per session — the gateway reaches the pod IP recorded in Convex directly; the `NetworkPolicy` is two policies (gateway-only ingress to session pods, internet-only egress excluding RFC 1918, link-local and CGNAT ranges), not enforced by kind's default CNI and enforced on EKS Auto Mode only once the `kube-system/amazon-vpc-cni` ConfigMap enables the network-policy controller (Phase 5: `deploy:dev chart` applies it; DNS egress to the cluster DNS service IP is allowed explicitly because Auto Mode's CoreDNS is not a `kube-dns` pod); session `runner` values are `kubernetes` only (the legacy local runner was deleted); the dispatcher talks to the API server with a dependency-free REST client, not `@kubernetes/client-node`.
- Date: 2026-10-22
- Decision owners: Learning Lab Platform maintainers
- Supersedes: [ADR 0001](0001-hosted-execution-model.md)

## Context

The platform is being redesigned around a Killercoda-style learner experience
(see `docs/2026-10-22/redesign-plan.md`): a terminal-first scenario shell with
step-by-step instructions, with OpenVSCode and a Vite preview retained as tabs
for React scenarios.

ADR 0001 selected ECS on Fargate for one-task-per-session React labs and
explicitly deferred EKS until a scenario needed a real Kubernetes API. That
plan was validated but never carried learner traffic, and its staging and
production environments were destroyed on 2026-08-16.

The redesign changes the requirements:

- Terminal scenarios are the primary content type. Many of the areas the
  catalog is modelled on (Kubernetes, Helm, Istio, Argo…) will eventually need
  a learner-visible Kubernetes API.
- Local development and the hosted environment should run the *same* session
  orchestration code so the UI, agent, and lifecycle are exercised locally
  before they reach AWS.
- Only two environments exist: `local` and `dev` (ADR 0007).

## Decision

Run every learner session as one Kubernetes **Pod** in a dedicated `sessions`
namespace.

- **Local:** a `kind` cluster on the developer's Docker Desktop.
- **Dev:** an **EKS Auto Mode** cluster in the existing AWS account
  (`us-east-2`). Auto Mode is chosen so that node provisioning, the AWS Load
  Balancer Controller, EBS CSI, and CoreDNS are managed by AWS; nothing in the
  platform depends on node-group details.
- The same Helm chart (`deploy/helm/learning-lab`) deploys the dispatcher and
  the session gateway to both clusters; only values differ.
- A **dispatcher** Deployment polls Convex for `requested` sessions and
  creates a Pod per session (no Service; see the 2026-10-25 amendment), labelled with the
  session ID and annotated with its expiry. It records the pod IP and an
  opaque route ID in Convex, reaps stopped and expired pods, and reconciles
  pods against Convex on start.
- The **session gateway** Deployment (the design intent of ADR 0003/0004
  carries over; ECS-specific mechanics are replaced here) is the only
  ingress to session pods. It terminates learner auth, proxies HTTP and
  WebSocket traffic (`/pty`, `/editor`, `/steps`) to the pod's agent port and
  the preview to the pod's preview port, and is exposed by an ALB in dev and
  a `kind` port mapping locally.
- A single container image, `session-workspace`, provides bash, git, Node,
  OpenVSCode, and the Node **session agent** that owns the PTYs, proxies the
  editor, and runs scenario step scripts (the preview is served by Vite on
  its own port).
- Pods run with explicit CPU, memory, and ephemeral-storage requests and
  limits, under a `ResourceQuota`, a default-deny `NetworkPolicy` with an
  egress allow-list, no privileged mode, and no host namespaces. A scenario
  may request that its PTY runs as `root` *inside* the container; it cannot
  request host or cluster privileges.
- Session `runner` values in Convex are `kubernetes` only (the legacy `local`
  Docker runner was removed in Phase 3).

## Out of scope (recorded for later)

- Scenarios that expose a real Kubernetes API to the learner. The intended
  path is a `vcluster` per session inside the same pod model; nothing here
  prevents it.
- Any environment beyond `local` and `dev`.

## Consequences

- All ECS/Fargate code, Terraform, scripts, docs, and the staging/production
  roots are removed from the repository. Git history retains them.
- The Terraform state backend and account-security stacks remain as-is; a new
  `environments/dev` root and `modules/eks-platform` module are added.
- Images are built for the architecture the dev cluster schedules on. Auto
  Mode defaults to Graviton; images are built ARM64-first with amd64 for kind
  on Intel hosts (multi-arch manifests).
- Operating a Kubernetes cluster (upgrades, add-on versions, RBAC) becomes
  part of the platform's responsibility, mitigated by Auto Mode.
