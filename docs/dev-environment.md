# The `dev` environment (EKS)

`dev` is the one hosted environment (ADR 0007): EKS Auto Mode in account
`442359104502`, region `us-east-2`, the frontend on S3 + CloudFront, Convex
`prod:upbeat-crab-254`, and the Clerk development instance (required).

| | value |
|---|---|
| App | `https://app.dev.learning-lab-platform.rumothy.com` (CloudFront) |
| Session endpoints | `ws-<route>.dev.learning-lab-platform.rumothy.com`, `pv-<route>.…` (ALB → gateway) |
| Cluster | `learning-lab-dev` (Auto Mode: `general-purpose` + `system` node pools) |
| Scenario bundles | `s3://learning-lab-dev-bundles-<account>-us-east-2/scenarios/<slug>/bundles/sha256/<digest>.tar`, approved in Convex |
| Terraform | `infra/aws/environments/dev` → `modules/eks-platform`; state key `learning-lab-platform/dev/terraform.tfstate` |

The app and the session hosts share the site `rumothy.com`, so the gateway's
`SameSite=Lax` `__Host-llp` cookie is sent from the app to the endpoint hosts
(ADR 0004). The ALB terminates TLS with the wildcard certificate and keeps
idle connections for an hour (WebSocket terminals).

## One-time setup

1. **Terraform.** Copy `dev.s3.tfbackend.example` → `dev.s3.tfbackend` and
   `dev.tfvars.example` → `dev.tfvars` in `infra/aws/environments/dev`
   (both ignored). Set `parent_domain` and decide the DNS zone **before the
   first apply** (the tfvars example spells out both options):

   - **Existing zone:** a public Route 53 zone in this account holds
     `parent_domain` (the zone named `parent_domain` is looked up; set
     `dns_zone_name` when it is a parent, e.g. `rumothy.com`). Then:

     ```bash
     npm run infra:dev:init
     npm run infra:dev:plan
     npm run infra:dev:apply      # ~15 min: VPC, EKS, ECR, ACM, Route 53, S3, CloudFront
     ```

   - **New zone** (`create_dns_zone = true`): a full apply would wait on
     certificate validation until the zone is delegated, and the
     `name_servers` output only appears once an apply finishes. Apply the
     zone alone first, delegate it, then apply everything:

     ```bash
     npm run infra:dev:init
     terraform -chdir=infra/aws/environments/dev apply -var-file=dev.tfvars \
       -target=module.platform.aws_route53_zone.environment
     terraform -chdir=infra/aws/environments/dev output name_servers
     # if the output is empty: aws route53 list-hosted-zones-by-name --dns-name dev.<parent_domain>
     #   then aws route53 get-hosted-zone --id <zone id> --query DelegationSet.NameServers
     # add those as NS records for dev.<parent_domain> at the parent; wait until
     #   dig +short NS dev.<parent_domain> returns them
     npm run infra:dev:apply
     ```

   The principal that applies becomes cluster admin
   (`bootstrap_cluster_creator_admin_permissions`); add others with
   `cluster_admin_principal_arns` (never the applying principal itself: a
   second access entry for it fails). The Kubernetes version defaults to
   `1.34` with `upgrade_policy` standard support only; check
   `aws eks describe-cluster-versions` before raising it.

   Commit `infra/aws/environments/dev/.terraform.lock.hcl` after the first
   `infra:dev:init` so every machine uses the same provider build (as
   `account-security` does).

2. **Convex.** The dev deployment is the project's `prod` deployment
   (`upbeat-crab-254`). Pin it: create a **production deploy key** for it in
   the Convex dashboard (Settings → Deploy keys) and put it in `.env.dev` as
   `CONVEX_DEPLOY_KEY`. Every Convex CLI call the deploy scripts make then
   targets exactly that deployment (and needs no `npx convex login`).
   Without a key the CLI's `--prod` flag resolves to the prod deployment of
   whatever project `.env.local`'s `CONVEX_DEPLOYMENT` names, so a stale
   `.env.local` would deploy elsewhere; `deploy:dev convex` refuses a target
   whose `HOSTED_ENVIRONMENT` is set to anything but `dev` and checks it reads
   `dev` after the deploy, but the key is the real pin.

   Before the first deploy, clear rows left by the retired ECS plan
   (`scenarioArtifactApprovals`, `sessions`, `runnerHeartbeats` with
   `environment: staging` or `runner: aws-ecs-fargate`; every pre-Phase-1
   `hostedScenario`/`runtime` value) from the dashboard — the schema no
   longer accepts them. Then set the values the deploy script does not
   (with the deploy key exported, drop `--prod`):

   ```bash
   npx convex env set CLERK_JWT_ISSUER_DOMAIN https://amazed-adder-35.clerk.accounts.dev --prod
   npx convex env set MAX_ACTIVE_SESSIONS 20 --prod
   ```

   `deploy:dev convex` sets `HOSTED_ENVIRONMENT=dev` and
   `RUNNER_SHARED_SECRET` (from `.env.dev`) itself. The Convex CLI only
   accepts the secret on its command line, so it is briefly visible in the
   local process list; the script redacts it from its own error output.
   `ALLOW_UNAUTHENTICATED_LOCAL_MODE` must stay unset on dev.

3. **`.env.dev`** (ignored) for the deploy scripts:

   ```text
   VITE_CONVEX_URL=https://upbeat-crab-254.convex.cloud
   VITE_CLERK_PUBLISHABLE_KEY=pk_test_…
   RUNNER_SHARED_SECRET=<long random value>
   CONVEX_DEPLOY_KEY=prod:upbeat-crab-254|…
   ```

   Only the steps that use a value require it: `chart` and `convex` need
   the Convex URL and runner secret, `frontend` the URL and Clerk key;
   `images`, `dns`, `status` and `teardown` need only Terraform outputs.

4. **Clerk.** If your Clerk development instance restricts origins or
   redirect URLs, add `https://app.dev.learning-lab-platform.rumothy.com`
   (Clerk dashboard → Domains / Paths; development instances accept any
   `localhost` origin already).

5. **Docker buildx.** The images are pushed for `linux/amd64` and
   `linux/arm64`, which needs a `docker-container` builder and, for the
   non-native platform, QEMU emulation (Docker Desktop ships it):

   ```bash
   docker buildx create --name llp --use
   docker buildx inspect --bootstrap    # lists linux/amd64 and linux/arm64
   ```

   `IMAGE_PLATFORMS=linux/amd64 npm run deploy:dev -- images` builds one
   platform (faster; Auto Mode's `general-purpose` pool may schedule on
   either architecture, so only use a single platform if you know the nodes).

## Deploying

```bash
npm run deploy:dev                # images → convex → chart → dns → scenarios → frontend
npm run deploy:dev -- images      # multi-arch build + push to ECR, digests recorded in build/dev-images.json
npm run deploy:dev -- convex      # HOSTED_ENVIRONMENT + RUNNER_SHARED_SECRET, convex deploy --yes, labs:seedScenarios
npm run deploy:dev -- chart       # network-policy switch, then helm upgrade with values-dev.yaml + Terraform outputs
npm run deploy:dev -- dns         # *.dev.<domain> CNAME → the Ingress ALB (after the first chart install)
npm run deploy:dev -- scenarios   # bundles → S3 by digest → scenarioArtifacts:approve
npm run deploy:dev -- frontend    # vite build --mode production → s3 sync → CloudFront invalidation
npm run deploy:dev -- status
npm run deploy:dev -- teardown    # before infra:dev:destroy (see Operating)
```

Every step reads `terraform output -json` from the dev root, so nothing
environment-specific is written into the repository. `main` deploys to dev;
there is no promotion pipeline (CI arrives in Phase 6). Convex goes first in
`all` so the deployment already holds the runner secret the new pods use.

Image tags are the commit SHA; a dirty working tree gets
`<sha>-dirty-<unix time>` so a tag never names two builds (the chart always
deploys by digest). ECR keeps the 10 newest tagged images per repository
and expires untagged ones after 7 days (the per-platform children of a
multi-arch image are untagged but protected while their index exists).

The chart gets `convexUrl` and `runnerSecret` from a temporary `0600`
values file under `build/` (deleted afterwards), never `--set`. The
dispatcher and gateway pods carry a checksum of both, so a changed secret
rolls them.

The frontend build sets `VITE_CONVEX_URL`, `VITE_AUTH_MODE=configured`,
`VITE_CLERK_PUBLISHABLE_KEY` and `VITE_PRODUCT_SURFACE=dev` explicitly;
those win over `.env`/`.env.local`, but any other `VITE_` value in those
files still reaches the build, so keep local-only switches out of them or
unset them before deploying. Hashed files under `assets/` are uploaded with
a one-year immutable `Cache-Control` and never deleted (a tab still on the
previous build can load its lazy chunks); everything else, including
`index.html`, with `no-cache`. CloudFront caches `assets/*` and revalidates
everything else, and sends `frame-ancestors 'none'` (plus
`X-Frame-Options: DENY`) on every response.

### How sessions get their scenario in dev

Local kind mounts `scenarios/` into the node (`BUNDLE_MODE=hostPath`). In
dev the dispatcher runs with `BUNDLE_MODE=s3`: `sessions.request` records the
active approval (`hostedScenario`: key + sha256) on the session; the
dispatcher presigns a 15-minute GET URL for that key with its Pod Identity
credentials (`runner/shared/aws-sigv4.mjs`, no SDK) and the pod's `bundle`
init container (busybox from the public ECR mirror, pinned by tag only)
downloads it (three attempts), checks the digest, and unpacks it into the
`/scenario` volume. Integrity rests on that digest check, not on TLS (busybox
`wget` may not verify certificates). Session pods never hold AWS
credentials. The dispatcher's role can only `s3:GetObject` the
`scenarios/*/bundles/sha256/*` keys; credential or presign failures are
logged and retried on the next tick until the startup timeout, rather than
failing the session at once. In s3 mode the pod is shaped by the runtime
contract approved with the bundle (`hostedScenario.runtime`), not by the
live `labs` row.

`sessions.request` itself rejects a scenario with no active approval for
`dev` ("Hosted scenario artifact is not approved for this environment"),
so learners see the error before any pod exists; the dispatcher's "no
approved scenario bundle" error only covers rows created before the
approval existed. Run `npm run deploy:dev -- scenarios` after changing
scenarios.

Session pods carry `karpenter.sh/do-not-disrupt: "true"`, so Auto Mode
does not evict them when it consolidates nodes (a node with a session pod
is only reclaimed after the pod ends; `activeDeadlineSeconds` bounds that).

### What is not Terraform

- The `*.dev.<domain>` CNAME is written by `deploy:dev dns` because the ALB
  only exists once the Ingress is created by the chart.
- Kubernetes objects (namespaces, RBAC, quotas, network policies, Ingress,
  IngressClass) are the Helm chart, as on kind.
- The `kube-system/amazon-vpc-cni` ConfigMap that switches on Auto Mode's
  network-policy controller (`enable-network-policy-controller: "true"`) is
  applied by `deploy:dev chart` with `kubectl apply --server-side`, not by
  the chart: Auto Mode may already have that ConfigMap and Helm refuses to
  adopt objects it did not create.
- Convex environment variables and Clerk settings are set by hand (above).

## Operating

- `npm run deploy:dev -- status` — pods in both namespaces, the Ingress, dispatcher log tail.
- `kubectl --context learning-lab-dev -n sessions get pods` — one pod per session; `describe` a pod stuck in `Init` to see the bundle download.
- Network policies: sessions may be reached only by the gateway and may only
  talk to the internet (RFC 1918, link-local and CGNAT ranges excluded) plus
  cluster DNS. Auto Mode enforces this **only** with the ConfigMap above. On
  Auto Mode CoreDNS is not a `k8s-app=kube-dns` pod, so the egress policy
  also allows `<service CIDR>.10` on port 53 (`sessions.dnsServiceIp`, from
  the Terraform output `cluster_dns_ip`). Verify on the first deploy:
  - `kubectl --context learning-lab-dev -n kube-system get configmap amazon-vpc-cni -o yaml` shows the flag;
  - a session pod becomes Ready (kubelet probes still pass with the ingress policy) and `getent hosts registry.npmjs.org` works in its terminal;
  - from a session terminal, `curl -m 3 http://<another session pod IP>:7000/healthz` and `curl -m 3 http://llp-gateway.learning-lab:8080/` both time out.
- The gateway runs two replicas spread across nodes with a
  PodDisruptionBudget (`minAvailable: 1`); each pod sleeps 15 s in `preStop`
  so the ALB deregisters it before it stops. Its HTTP keep-alive timeout
  (3605 s) is longer than the ALB idle timeout (3600 s) so the ALB never
  reuses a connection the gateway closed.
- Control-plane logs: CloudWatch `/aws/eks/learning-lab-dev/cluster` (api, audit, authenticator; 14 days).
- Tear down in this order (the Ingress-created ALB and its security groups
  block the VPC, subnet and certificate deletes, and the zone cannot be
  deleted while the `*.dev` CNAME is in it):

  ```bash
  npm run deploy:dev -- teardown    # helm uninstall → wait for the Ingress and ALB to go → delete the *.dev CNAME
  npm run infra:dev:destroy         # buckets and ECR repositories are force_destroy; nothing has deletion protection
  ```

## Known gaps (tracked in ROADMAP)

- No CI; images are built on the deploying machine.
- No TTL reaper beyond the dispatcher and `activeDeadlineSeconds`; no alarms (Phase 6).
- Image layers come from S3 through the gateway endpoint, but ECR API calls (`ecr.api`, `ecr.dkr`) and the public-ECR busybox pull go through the NAT gateways; interface endpoints would cut that once traffic warrants it.
- The bundle init image is `public.ecr.aws/docker/library/busybox:1.36`, pinned by tag; pin it by digest (`bundle.initImage`) once the digest has been looked up.
- Phase 4 security gaps now reachable from the internet (ROADMAP Phase 5): `labs.seedScenarios` has no auth check, `/admin` is not operator-gated, `sessions.list`/`progress.list` read a global window.
- `account-security` still checks the GuardDuty ECS Fargate agent setting (ECS leftover); replace it with the EKS runtime agent check once GuardDuty EKS Runtime Monitoring is enabled for this cluster.
