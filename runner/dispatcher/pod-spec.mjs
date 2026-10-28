// Builds the Pod manifest for one learner session (ADR 0005). Pure function:
// unit-tested, no cluster access.

export const SESSION_LABEL = "app.kubernetes.io/name"
export const SESSION_LABEL_VALUE = "llp-session"
export const SESSION_ID_LABEL = "learning-lab/session"
export const ROUTE_ID_LABEL = "learning-lab/route"

const LEARNER_UID = 1001
const DEFAULT_RESOURCES = {
  requests: { cpu: "250m", memory: "512Mi", "ephemeral-storage": "1Gi" },
  limits: { cpu: "2", memory: "2Gi", "ephemeral-storage": "4Gi" },
}

export function podNameFor(sessionId) {
  const safe = String(sessionId).toLowerCase().replace(/[^a-z0-9]/g, "")
  return `llp-${safe}`.slice(0, 63)
}

/**
 * @param {{
 *   session: { _id: string, ttlSeconds: number, expiresAt: number },
 *   lab: { slug: string, kind: string, sourceDir: string, workspace: { cwd: string, user: string }, react?: { previewPort: number } },
 *   routeId: string,
 *   agentToken: string,
 *   config: {
 *     namespace: string, image: string, imagePullPolicy?: string, agentPort?: number,
 *     convexUrl: string, bundle: { mode: "hostPath", hostRoot: string } | { mode: "s3", initImage?: string },
 *     resources?: object, startupGraceSeconds?: number,
 *   },
 *   bundleDownload?: { url: string, sha256: string },   // s3 mode: presigned GET of the approved bundle
 * }} input
 */
const WORKSPACE_CWD = /^\/(workspace|home\/[a-z][a-z0-9_-]*)(\/[A-Za-z0-9._-]+)*\/?$/

/**
 * `workspace.cwd` becomes a volume mountPath, so it must stay inside the
 * learner's area: `/workspace[/…]` or `/home/<user>[/…]`. Anything else
 * (`/scenario`, `/etc`, `/`, `..`) would shadow the image or the bundle.
 */
export function workspaceMountPath(cwd) {
  const value = cwd ?? "/workspace"
  if (typeof value !== "string" || !WORKSPACE_CWD.test(value) || value.includes("/../") || value.endsWith("/..")) {
    throw new Error(`workspace.cwd ${JSON.stringify(cwd)} must be under /workspace or /home/<user>`)
  }
  return value.length > 1 ? value.replace(/\/+$/, "") : value
}

export function buildPodSpec({ session, lab, routeId, agentToken, config, bundleDownload }) {
  const agentPort = config.agentPort ?? 7000
  const asRoot = lab.workspace?.user === "root"
  const workspacePath = workspaceMountPath(lab.workspace?.cwd)
  const uid = asRoot ? 0 : LEARNER_UID
  const previewPort = lab.kind === "react" ? lab.react?.previewPort : undefined
  const name = podNameFor(session._id)
  const bundleVolume = bundleVolumeFor(lab, config.bundle, bundleDownload, config.image)

  const ports = [{ name: "agent", containerPort: agentPort }]
  if (previewPort) ports.push({ name: "preview", containerPort: previewPort })

  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name,
      namespace: config.namespace,
      labels: {
        [SESSION_LABEL]: SESSION_LABEL_VALUE,
        [SESSION_ID_LABEL]: String(session._id),
        [ROUTE_ID_LABEL]: routeId,
        "learning-lab/scenario": lab.slug,
      },
      annotations: {
        "learning-lab/expires-at": new Date(session.expiresAt).toISOString(),
        // EKS Auto Mode (Karpenter) consolidates under-used nodes by evicting
        // pods; a session pod is not restartable, so opt it out. Ignored on kind.
        "karpenter.sh/do-not-disrupt": "true",
      },
    },
    spec: {
      restartPolicy: "Never",
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      terminationGracePeriodSeconds: 10,
      // Kubelet kills the pod at TTL even if the dispatcher is down.
      activeDeadlineSeconds: session.ttlSeconds + (config.startupGraceSeconds ?? 600),
      // dev publishes amd64-only images (CI), so session pods are pinned to
      // that architecture there (SESSION_NODE_ARCH); unset locally (kind).
      ...(config.nodeArch ? { nodeSelector: { "kubernetes.io/arch": config.nodeArch } } : {}),
      securityContext: {
        runAsUser: uid,
        runAsGroup: uid,
        fsGroup: LEARNER_UID,
        runAsNonRoot: !asRoot,
        seccompProfile: { type: "RuntimeDefault" },
      },
      volumes: [
        bundleVolume.volume,
        { name: "workspace", emptyDir: { sizeLimit: config.workspaceSizeLimit ?? "2Gi" } },
        { name: "home", emptyDir: { sizeLimit: "1Gi" } },
      ],
      ...(bundleVolume.initContainers ? { initContainers: bundleVolume.initContainers } : {}),
      containers: [
        {
          name: "workspace",
          image: config.image,
          imagePullPolicy: config.imagePullPolicy ?? "IfNotPresent",
          ports,
          env: [
            { name: "LAB_SCENARIO_DIR", value: "/scenario" },
            { name: "AGENT_PORT", value: String(agentPort) },
            { name: "CONVEX_URL", value: config.convexUrl },
            { name: "SESSION_ID", value: String(session._id) },
            { name: "SESSION_TOKEN", value: agentToken },
            { name: "HOME", value: asRoot ? "/root" : "/home/learner" },
          ],
          volumeMounts: [
            { name: "scenario", mountPath: "/scenario", readOnly: true },
            { name: "workspace", mountPath: workspacePath },
            { name: "home", mountPath: asRoot ? "/root" : "/home/learner" },
          ],
          securityContext: {
            allowPrivilegeEscalation: false,
            privileged: false,
            capabilities: { drop: ["ALL"] },
          },
          resources: config.resources ?? DEFAULT_RESOURCES,
          readinessProbe: {
            httpGet: { path: "/ready", port: agentPort },
            initialDelaySeconds: 1,
            periodSeconds: 2,
            failureThreshold: 150,
          },
          livenessProbe: {
            httpGet: { path: "/healthz", port: agentPort },
            initialDelaySeconds: 10,
            periodSeconds: 10,
            failureThreshold: 3,
          },
        },
      ],
    },
  }
}

const BUNDLE_DIGEST = /^[0-9a-f]{64}$/

// Runs in the session pod before the workspace container: download the
// approved bundle with the presigned URL (three attempts, 5 s apart), check
// its digest, unpack it into the scenario volume. By default it runs in the
// session image itself (curl with CA certificates, coreutils, GNU tar), which
// the node has to pull anyway; `bundle.initImage` can point at a smaller
// image with the same tools. Busybox is NOT suitable: its wget cannot
// complete a TLS handshake with S3. The URL is a short-lived presign for one
// object, so a pod reader learns nothing lasting; integrity rests on the
// sha256 check against the digest Convex approved.
const BUNDLE_INIT_SCRIPT = [
  "set -eu",
  "attempt=1",
  "download() {",
  "  if command -v curl >/dev/null 2>&1; then",
  '    curl -fsS --proto =https --tlsv1.2 --max-time 120 --retry 3 --retry-delay 5 -o /tmp/bundle.tar "$BUNDLE_URL"',
  "  else",
  '    wget -q -T 60 -O /tmp/bundle.tar "$BUNDLE_URL"',
  "  fi",
  "}",
  "until download; do",
  '  if [ "$attempt" -ge 3 ]; then echo "bundle download failed after $attempt attempts" >&2; exit 1; fi',
  "  attempt=$((attempt + 1))",
  "  rm -f /tmp/bundle.tar",
  "  sleep 5",
  "done",
  // GNU coreutils has --status, busybox has -s; redirecting is portable.
  'echo "$BUNDLE_SHA256  /tmp/bundle.tar" | sha256sum -c >/dev/null',
  "tar -xf /tmp/bundle.tar -C /scenario",
  "rm -f /tmp/bundle.tar",
].join("\n")

function bundleVolumeFor(lab, bundle, download, image) {
  if (!lab.sourceDir || /(^|\/)\.\.(\/|$)/.test(lab.sourceDir) || lab.sourceDir.startsWith("/")) {
    throw new Error(`scenario ${lab.slug} has no safe sourceDir`)
  }
  if (bundle?.mode === "hostPath") {
    return {
      volume: {
        name: "scenario",
        hostPath: { path: `${bundle.hostRoot.replace(/\/+$/, "")}/${lab.sourceDir}`, type: "Directory" },
      },
    }
  }
  if (bundle?.mode === "s3") {
    if (!download?.url || !BUNDLE_DIGEST.test(download.sha256 ?? "")) {
      throw new Error(`scenario ${lab.slug}: s3 bundle mode needs a presigned download URL and sha256`)
    }
    if (!/^https:\/\//.test(download.url)) throw new Error(`scenario ${lab.slug}: bundle URL must be https`)
    return {
      volume: { name: "scenario", emptyDir: { sizeLimit: "256Mi" } },
      initContainers: [
        {
          name: "bundle",
          image: bundle.initImage ?? image,
          imagePullPolicy: "IfNotPresent",
          command: ["/bin/sh", "-c", BUNDLE_INIT_SCRIPT],
          env: [
            { name: "BUNDLE_URL", value: download.url },
            { name: "BUNDLE_SHA256", value: download.sha256 },
          ],
          volumeMounts: [{ name: "scenario", mountPath: "/scenario" }],
          securityContext: {
            allowPrivilegeEscalation: false,
            privileged: false,
            capabilities: { drop: ["ALL"] },
          },
          resources: {
            requests: { cpu: "50m", memory: "64Mi" },
            limits: { cpu: "500m", memory: "256Mi" },
          },
        },
      ],
    }
  }
  throw new Error(`unknown bundle mode ${bundle?.mode}`)
}
