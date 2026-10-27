// Minimal Kubernetes REST client — only what the dispatcher needs (pods in
// one namespace). Dependency-free.
//
//   in-cluster: KUBERNETES_SERVICE_HOST/PORT + the mounted service account
//               (the projected token rotates; it is re-read once on a 401)
//   kubeconfig: `kubectl config view --raw --minify -o json` (developer machine).
//               Only client-certificate and static-token users are supported
//               (kind, k3s); exec/auth-provider credential plugins (EKS,
//               GKE, …) are not — use the in-cluster deployment there.

import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { request as httpRequest } from "node:http"
import { Agent, request as httpsRequest } from "node:https"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const SERVICE_ACCOUNT_DIR = "/var/run/secrets/kubernetes.io/serviceaccount"

export class KubernetesError extends Error {
  constructor(message, status, body) {
    super(message)
    this.name = "KubernetesError"
    this.status = status
    this.body = body
  }
}

async function inClusterConfig() {
  const host = process.env.KUBERNETES_SERVICE_HOST
  const port = process.env.KUBERNETES_SERVICE_PORT ?? "443"
  if (!host) return null
  const [token, ca] = await Promise.all([
    readFile(`${SERVICE_ACCOUNT_DIR}/token`, "utf8"),
    readFile(`${SERVICE_ACCOUNT_DIR}/ca.crt`).catch(() => undefined),
  ])
  return { server: `https://${host}:${port}`, token: token.trim(), ca }
}

async function kubeconfigConfig() {
  const { stdout } = await execFileAsync("kubectl", ["config", "view", "--raw", "--minify", "-o", "json"])
  const config = JSON.parse(stdout)
  const cluster = config.clusters?.[0]?.cluster
  const user = config.users?.[0]?.user
  if (!cluster?.server) throw new Error("kubeconfig has no current cluster")
  if (user?.exec || user?.["auth-provider"]) {
    throw new Error("kubeconfig user uses an exec/auth-provider credential plugin, which k8s.mjs does not support (client certificates or a static token only)")
  }
  const decode = (value) => (value ? Buffer.from(value, "base64") : undefined)
  return {
    server: cluster.server,
    ca: decode(cluster["certificate-authority-data"]) ?? (cluster["certificate-authority"] ? await readFile(cluster["certificate-authority"]) : undefined),
    cert: decode(user?.["client-certificate-data"]) ?? (user?.["client-certificate"] ? await readFile(user["client-certificate"]) : undefined),
    key: decode(user?.["client-key-data"]) ?? (user?.["client-key"] ? await readFile(user["client-key"]) : undefined),
    token: user?.token,
  }
}

/**
 * @param {{ mode?: "auto"|"in-cluster"|"kubeconfig", namespace: string, config?: object, timeoutMs?: number }} options
 */
export async function createKubernetesClient({ mode = "auto", namespace, config, timeoutMs = 15_000 }) {
  if (!namespace) throw new Error("namespace is required")
  const resolved =
    config ??
    (mode === "kubeconfig" ? await kubeconfigConfig() : (await inClusterConfig()) ?? (mode === "in-cluster" ? null : await kubeconfigConfig()))
  if (!resolved) throw new Error("not running in a cluster and no kubeconfig available")
  const server = new URL(resolved.server)
  const agent = server.protocol === "https:" ? new Agent({ ca: resolved.ca, cert: resolved.cert, key: resolved.key, keepAlive: true }) : undefined

  const inCluster = !config && Boolean(process.env.KUBERNETES_SERVICE_HOST) && mode !== "kubeconfig"

  async function refreshToken() {
    if (!inCluster) return false
    const token = (await readFile(`${SERVICE_ACCOUNT_DIR}/token`, "utf8")).trim()
    if (token === resolved.token) return false
    resolved.token = token
    return true
  }

  async function request(method, path, options = {}) {
    try {
      return await send(method, path, options)
    } catch (error) {
      // The projected service-account token rotates; re-read it once and retry.
      if (error.status === 401 && (await refreshToken())) return await send(method, path, options)
      // A 400 without a Kubernetes Status body (or a dropped socket) on an
      // idempotent read is a connection-level hiccup, e.g. a keep-alive socket
      // the API server closed; retry once on a fresh connection.
      const connectionLevel = error.status === undefined || (error.status === 400 && error.body?.kind !== "Status")
      if (method === "GET" && connectionLevel && !options.retried) {
        agent?.destroy()
        return await send(method, path, { ...options, retried: true })
      }
      throw error
    }
  }

  function send(method, path, { body, query } = {}) {
    const url = new URL(path, server)
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value)
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
    const headers = { accept: "application/json" }
    if (payload !== undefined) {
      headers["content-type"] = "application/json"
      headers["content-length"] = String(payload.length)
    }
    if (resolved.token) headers.authorization = `Bearer ${resolved.token}`
    const transport = server.protocol === "https:" ? httpsRequest : httpRequest
    return new Promise((resolve, reject) => {
      const req = transport(url, { method, headers, agent, timeout: timeoutMs }, (res) => {
        let data = ""
        res.setEncoding("utf8")
        res.on("data", (chunk) => (data += chunk))
        res.on("end", () => {
          let parsed = null
          try {
            parsed = data ? JSON.parse(data) : null
          } catch {
            parsed = { raw: data }
          }
          if ((res.statusCode ?? 500) >= 400) {
            const detail = parsed?.message ?? (data ? data.slice(0, 300) : "(empty body)")
            reject(new KubernetesError(`${method} ${path} → ${res.statusCode}: ${detail}`, res.statusCode, parsed))
          } else {
            resolve({ status: res.statusCode, body: parsed })
          }
        })
      })
      req.on("timeout", () => req.destroy(new Error(`${method} ${path} timed out`)))
      req.on("error", reject)
      if (payload !== undefined) req.write(payload)
      req.end()
    })
  }

  const pods = `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods`
  return {
    namespace,
    server: resolved.server,
    request,
    async getPod(name) {
      try {
        return (await request("GET", `${pods}/${encodeURIComponent(name)}`)).body
      } catch (error) {
        if (error.status === 404) return null
        throw error
      }
    },
    async listPods(labelSelector) {
      const { body } = await request("GET", pods, { query: labelSelector ? { labelSelector } : {} })
      return body?.items ?? []
    },
    async createPod(manifest) {
      return (await request("POST", pods, { body: manifest })).body
    },
    async deletePod(name, { gracePeriodSeconds = 10 } = {}) {
      try {
        await request("DELETE", `${pods}/${encodeURIComponent(name)}`, { body: { gracePeriodSeconds } })
        return true
      } catch (error) {
        if (error.status === 404) return false
        throw error
      }
    },
  }
}

/** True when the pod reports Ready and has an IP. */
export function podIsReady(pod) {
  const ready = pod?.status?.conditions?.find((condition) => condition.type === "Ready")
  return Boolean(pod?.status?.podIP) && ready?.status === "True"
}

export function podPhase(pod) {
  return pod?.status?.phase ?? "Unknown"
}
