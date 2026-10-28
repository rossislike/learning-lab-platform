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
   `account-security` does). Record the checksums for both the laptop and
   the CI runners first, or CI's `init -lockfile=readonly` has only the
   registry hashes to go on:

   ```bash
   terraform -chdir=infra/aws/environments/dev providers lock \
     -platform=linux_amd64 -platform=darwin_arm64
   ```

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
   platform (faster). dev pins every pod — gateway, dispatcher, reaper and
   session pods — to `kubernetes.io/arch: amd64` (`nodeArch` in
   `values-dev.yaml`; the dispatcher passes it to session pods as
   `SESSION_NODE_ARCH`), because CI pushes amd64-only images, so amd64 is all
   dev needs; the arm64 half of a local multi-arch push is unused there.

## Operators

`/admin` (sessions of every learner, Stop, Seed scenarios) is for operators.
The role is a field on the `users` row and is granted from the CLI after the
person has signed in once:

```bash
# The deploy key from .env.dev pins the target; `--prod` would pick the prod
# deployment of whatever project .env.local points at (not upbeat-crab-254).
export CONVEX_DEPLOY_KEY="$(grep '^CONVEX_DEPLOY_KEY=' .env.dev | cut -d= -f2- | tr -d "'\"")"
npx convex env get HOSTED_ENVIRONMENT                # sanity: dev
npx convex run users:grantOperator '{"email":"you@example.com"}'
npx convex run users:grantOperator '{"email":"you@example.com","revoke":true}'
```

If more than one account carries the email the mutation
refuses; pass `{"clerkSubject":"user_…"}` (Clerk dashboard → Users → user ID)
instead. Operators can see and stop every session and read its events; they
get no workspace or step access to another learner's session.

Locally with auth disabled everyone is an operator. Learner queries
(`sessions.list`, `progress.list`) are owner-indexed; `sessions.listAll` and
`labs.seedScenarios` require the role.

## Deploying

```bash
npm run deploy:dev                # images → convex → chart → dns → scenarios → frontend
npm run deploy:dev -- images      # multi-arch build + push to ECR, digests recorded in build/dev-images.json
npm run deploy:dev -- convex      # HOSTED_ENVIRONMENT + RUNNER_SHARED_SECRET, convex deploy --yes, labs:seedCatalogInternal
npm run deploy:dev -- chart       # network-policy switch, then helm upgrade with values-dev.yaml + Terraform outputs
npm run deploy:dev -- dns         # *.dev.<domain> CNAME → the Ingress ALB (after the first chart install)
npm run deploy:dev -- scenarios   # bundles → S3 by digest → scenarioArtifacts:approve
npm run deploy:dev -- frontend    # vite build --mode production → s3 sync → CloudFront invalidation
npm run deploy:dev -- status
npm run deploy:dev -- teardown    # before infra:dev:destroy (see Operating)
```

Every step reads `terraform output -json` from the dev root, so nothing
environment-specific is written into the repository. `main` deploys to dev
(CI, below); there is no promotion pipeline. Convex goes first in
`all` so the deployment already holds the runner secret the new pods use.

Image tags are the commit SHA (`IMAGE_TAG` overrides it; CI sets it to the
commit); a dirty working tree gets `<sha>-dirty-<unix time>` so a tag never
names two builds (the chart always deploys by digest). `chart` deploys the
digests `images` recorded in `build/dev-images.json`; without that file (a
fresh machine or runner) it looks up the images tagged `IMAGE_TAG`, or the
clean `HEAD` commit, in ECR. ECR keeps the 10 newest tagged images per repository
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
init container (the session image itself: `curl` with CA certificates,
`sha256sum`, GNU `tar`; override with `bundle.initImage`) downloads it with
TLS verification (three attempts), checks the digest, and unpacks it into the
`/scenario` volume. Busybox was tried first and cannot complete a TLS
handshake with S3 ("connection reset by peer"), which failed every session
on the first deploy. Session pods never hold AWS credentials. The dispatcher's role can only `s3:GetObject` the
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

## CI: main deploys to dev

`.github/workflows/ci.yml` runs on every pull request and push: lint, types,
unit tests, catalog check, a production frontend build, Terraform
`fmt`/`validate` for every root, `helm lint`/`template`, and the session-image
integration test (the image is built on the runner and the agent is driven
over Docker). On `main`, when all of that passes, `deploy-dev.yml` runs
`npm run deploy:dev` with AWS access through the GitHub OIDC role
(`infra/aws/modules/github-deploy`; it can read the dev Terraform state but
never apply it). Images are built for `linux/amd64` in CI, tagged with the
commit SHA, with the BuildKit layer cache in the GitHub Actions cache.

- Pull-request runs hold no secrets: no Convex deploy key, no AWS role.
  `convex/_generated` is committed for that reason (`convex codegen` needs a
  deployment); `npx convex dev` keeps it current locally — commit its changes.
- Pushes to `main` that only touch `docs/**`, top-level `*.md` or
  `infra/**/*.md` skip CI and the deploy (every deploy rebuilds the images,
  which rolls the gateway and drops open terminals). Scenario Markdown is
  not skipped.
- The deploy job talks to the EKS API over its **public endpoint** from
  GitHub-hosted runners, whose addresses change: keep
  `cluster_endpoint_public_access_cidrs` at its default, or CI deploys fail.
- The role's EKS access entry (cluster admin) is created by the dev apply;
  IAM and EKS access entries are eventually consistent, so a CI run started
  seconds after that apply can fail with `Unauthorized` — re-run it.
- The role decrypts the state object with the state bucket's KMS key, which
  works only if that key's policy delegates to IAM (the default key policy,
  which `bootstrap/terraform-backend` uses). Check once:
  `aws kms get-key-policy --key-id <terraform_state_kms_key_arn> --policy-name default`
  shows the `arn:aws:iam::442359104502:root` statement.

One-time GitHub setup (Settings → Secrets and variables → Actions, and an
environment named `dev`):

| kind | name | value |
|---|---|---|
| variable | `AWS_DEPLOY_ROLE_ARN` | `terraform output github_deploy_role_arn` |

Before the apply, set `github_sub_claim_prefix` in `dev.tfvars` to what
`gh api repos/<owner>/<repo>/actions/oidc/customization/sub` reports as
`sub_claim_prefix` (GitHub's immutable subjects qualify the owner and
repository with their ids; the trust policy accepts both forms).

| variable | `VITE_CONVEX_URL` | `https://upbeat-crab-254.convex.cloud` |
| variable | `VITE_CLERK_PUBLISHABLE_KEY` | the `amazed-adder-35` publishable key |
| secret | `RUNNER_SHARED_SECRET` | same value as `.env.dev` |
| secret | `CONVEX_DEPLOY_KEY` | a production deploy key for `upbeat-crab-254` |

**Required:** in the `dev` environment set *Deployment branches and tags* to
**Selected branches → `main`**. The AWS role trusts only the `dev`
environment's OIDC subject (`repo:<owner/name>:environment:dev`; a job that
names an environment never gets the branch subject), so this rule is the
only thing that stops another branch from deploying.

`deploy-dev.yml` can also be run by hand (*Run workflow*) with one
subcommand (`all`, `convex`, `chart`, `dns`, `scenarios`, `frontend`,
`status`); the environment rule above applies to those runs too. `chart` on
its own deploys the images CI pushed for that commit. Infrastructure changes
(`infra:dev:apply`) stay a manual, local step; the workflow only reads the
state.

## Alarms

The dispatcher publishes `LearningLab/Dispatcher` metrics (Heartbeat,
ActiveSessions, LaunchFailures, LostPods, PodsLaunched) through its Pod
Identity role. LaunchFailures counts sessions that failed to start; LostPods
counts running sessions whose pod disappeared (not alarmed).
`modules/eks-platform/monitoring.tf` turns them into alarms on the
`learning-lab-dev-alerts` SNS topic (subscribe with `alert_email` in
`dev.tfvars` — required, or the alarms reach nobody; confirm the email once):
dispatcher heartbeat missing for 10 min, ≥ 3 launch failures in 15 min,
gateway ALB 5xx (once `gateway_alb_arn_suffix` is set from
`deploy:dev status`), and an AWS Budgets daily cost guard
(`daily_cost_budget_usd`, default $10, on actual spend; AWS does not support
forecasted alerts on daily budgets).

Order matters on the first rollout: the heartbeat alarm treats missing data
as breaching, so it goes to ALARM (and emails) right after `infra:dev:apply`
and stays there until a chart with metrics enabled is deployed and the
dispatcher has published for a few minutes; it then sends OK. Apply, then
deploy promptly (or expect that one alarm).

`account-security` has its CloudTrail security alarms enabled in config
(`enable_learning_lab_alarms=true`; apply that root once). Expect them to
fire during the rollout itself — IAM, CloudWatch, SNS and security-group
change alarms on the dev apply and on the security groups the ALB
controller manages, and denied-API-call alarms while the CI role is new.

## TTL safety nets

The dispatcher expires sessions and deletes pods as part of its tick. Two
independent backstops cover the dispatcher being down: a Convex cron
(`convex/crons.ts` → `sessions.sweep`, every 5 min) expires sessions past
their TTL and errors sessions stuck in `requested`/`starting` while no
heartbeat has arrived, and the in-cluster `llp-reaper` CronJob
(`runner/dispatcher/reaper.mjs`, every 5 min, no Convex access; its own
`llp-reaper` Role can only get/list/delete pods in `sessions`) deletes pods
past their `learning-lab/expires-at` annotation or left in Failed/Succeeded.
Past-TTL sessions are found per live status (never through a global expiry
index that ended sessions would crowd out). A `starting` session whose pod
was removed (e.g. by the reaper after it failed) is errored once the startup
timeout has passed instead of being relaunched. `kubectl -n learning-lab get
jobs -l app.kubernetes.io/name=llp-reaper` lists the reaper runs.

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

- Image layers come from S3 through the gateway endpoint, but ECR API calls (`ecr.api`, `ecr.dkr`) go through the NAT gateways; interface endpoints would cut that once traffic warrants it.
- `account-security` still checks the GuardDuty ECS Fargate agent setting (ECS leftover); replace it with the EKS runtime agent check once GuardDuty EKS Runtime Monitoring is enabled for this cluster.
