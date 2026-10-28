import assert from "node:assert/strict"
import test from "node:test"
import { createDispatcher, endpointUrls, podFailureDetail, randomRouteId } from "./dispatcher.mjs"
import { buildPodSpec, podNameFor, workspaceMountPath, SESSION_ID_LABEL, SESSION_LABEL, SESSION_LABEL_VALUE } from "./pod-spec.mjs"
import { podIsReady } from "./k8s.mjs"

const quiet = { info() {}, warn() {}, error() {} }

const gitLab = {
  _id: "lab-git",
  slug: "first-commit",
  kind: "terminal",
  manifestVersion: 2,
  sourceDir: "git/first-commit",
  tabs: ["terminal"],
  workspace: { cwd: "/workspace", user: "learner" },
}
const reactLab = {
  ...gitLab,
  _id: "lab-react",
  slug: "welcome-message",
  kind: "react",
  sourceDir: "react/welcome-message",
  tabs: ["terminal", "editor", "preview"],
  react: { previewPort: 5173 },
}

const config = {
  namespace: "sessions",
  image: "learning-lab/session-workspace:dev",
  convexUrl: "https://example.convex.cloud",
  bundle: { mode: "hostPath", hostRoot: "/scenarios" },
  hostSuffix: "lab.localhost",
  publicPort: 8080,
  pollMs: 10,
  runnerId: "test-dispatcher",
}

/** In-memory stand-in for the Convex functions the dispatcher calls. */
function fakeConvex({ leaseHeld = true } = {}) {
  const sessions = new Map()
  const labs = new Map([[gitLab._id, gitLab], [reactLab._id, reactLab]])
  const calls = []
  let counter = 0
  const api = {
    now: () => Date.now(),
    addSession(lab, overrides = {}) {
      const id = `s${++counter}`
      sessions.set(id, {
        _id: id,
        labId: lab._id,
        status: "requested",
        ttlSeconds: 3600,
        createdAt: 1000,
        updatedAt: 1000,
        expiresAt: 1000 + 3600_000,
        ...overrides,
      })
      return id
    },
    get: (id) => sessions.get(id),
    calls,
    async mutation(path, args) {
      calls.push([path, args])
      const session = args.sessionId ? sessions.get(args.sessionId) : null
      switch (path) {
        case "runners:heartbeat":
          return "hb"
        case "runners:acquireLease":
          return leaseHeld
        case "sessions:markStarting":
          if (session.status !== "requested") return false
          session.status = "starting"
          session.updatedAt = api.now()
          return true
        case "sessions:issueAgentToken":
          session.agentTokenHash = "hashed"
          return { token: "t".repeat(64), expiresAt: 1 }
        case "sessions:updateRunnerMetadata":
          if (api.failNextMetadata) {
            api.failNextMetadata = false
            throw new Error("simulated Convex outage")
          }
          if (args.podIp !== undefined && !/^\d+\.\d+\.\d+\.\d+$/.test(args.podIp)) throw new Error("Invalid podIp")
          Object.assign(session, args, { updatedAt: api.now() })
          return true
        case "sessions:markRunning":
          session.status = "running"
          Object.assign(session, args)
          return true
        case "sessions:markErrored":
          session.status = "errored"
          session.error = args.message
          return true
        case "sessions:markExpired":
          session.status = "expired"
          return true
        case "sessions:markCleaned":
          session.cleanedAt = 1
          session.cleanupSummary = args.summary
          if (session.status === "stopping") session.status = "stopped"
          return true
        default:
          throw new Error(`unexpected mutation ${path}`)
      }
    },
    async query(path) {
      calls.push([path])
      if (path !== "sessions:listForDispatcher") throw new Error(`unexpected query ${path}`)
      const all = [...sessions.values()]
      const active = all.filter((s) => ["requested", "starting", "running", "checking", "passed", "failed", "stopping"].includes(s.status))
      return {
        startable: all.filter((s) => ["requested", "starting"].includes(s.status)).map((session) => ({ session, lab: labs.get(session.labId) ?? null })),
        expired: all.filter((s) => s.expiresAt < 0 && !["stopping", "stopped", "expired", "errored"].includes(s.status)),
        cleanup: all.filter((s) => !s.cleanedAt && ["stopping", "stopped", "expired", "errored"].includes(s.status)),
        active: active.map((s) => ({ sessionId: s._id, status: s.status, podName: s.podName ?? null })),
      }
    },
  }
  return api
}

/** In-memory Kubernetes: pods are created Pending and made Ready by the test. */
function fakeK8s() {
  const pods = new Map()
  return {
    pods,
    async getPod(name) {
      return pods.get(name) ?? null
    },
    async listPods(selector) {
      const [key, value] = selector.split("=")
      return [...pods.values()].filter((pod) => pod.metadata.labels?.[key] === value)
    },
    async createPod(manifest) {
      if (pods.has(manifest.metadata.name)) {
        const error = new Error("exists")
        error.status = 409
        throw error
      }
      const pod = structuredClone(manifest)
      pod.status = { phase: "Pending", conditions: [] }
      pod.metadata.creationTimestamp = new Date().toISOString()
      pods.set(manifest.metadata.name, pod)
      return pod
    },
    async deletePod(name) {
      return pods.delete(name)
    },
    ready(name, ip = "10.0.0.5") {
      const pod = pods.get(name)
      pod.status = { phase: "Running", podIP: ip, conditions: [{ type: "Ready", status: "True" }] }
    },
    fail(name) {
      pods.get(name).status = { phase: "Failed", conditions: [] }
    },
  }
}

test("pod spec: labels, security, env, bundle mount, ports, root opt-in", () => {
  const session = { _id: "jd7abc", ttlSeconds: 3600, expiresAt: 2_000_000 }
  const spec = buildPodSpec({ session, lab: reactLab, routeId: "r".repeat(24), agentToken: "tok", config })
  assert.equal(spec.metadata.name, "llp-jd7abc")
  assert.equal(spec.metadata.labels[SESSION_LABEL], SESSION_LABEL_VALUE)
  assert.equal(spec.metadata.labels[SESSION_ID_LABEL], "jd7abc")
  assert.equal(spec.spec.automountServiceAccountToken, false)
  assert.equal(spec.spec.securityContext.runAsUser, 1001)
  assert.equal(spec.spec.securityContext.runAsNonRoot, true)
  assert.equal(spec.spec.activeDeadlineSeconds, 3600 + 600)
  const container = spec.spec.containers[0]
  assert.deepEqual(container.securityContext.capabilities, { drop: ["ALL"] })
  assert.deepEqual(container.ports.map((p) => p.containerPort), [7000, 5173])
  const env = Object.fromEntries(container.env.map((e) => [e.name, e.value]))
  assert.equal(env.SESSION_TOKEN, "tok")
  assert.equal(env.SESSION_ID, "jd7abc")
  assert.equal(env.CONVEX_URL, config.convexUrl)
  assert.deepEqual(spec.spec.volumes[0].hostPath, { path: "/scenarios/react/welcome-message", type: "Directory" })
  assert.equal(container.readinessProbe.httpGet.path, "/ready")

  const rootSpec = buildPodSpec({ session, lab: { ...gitLab, workspace: { cwd: "/workspace", user: "root" } }, routeId: "r".repeat(24), agentToken: "tok", config })
  assert.equal(rootSpec.spec.securityContext.runAsUser, 0)
  assert.equal(rootSpec.spec.securityContext.runAsNonRoot, false)
  assert.equal(rootSpec.spec.containers[0].ports.length, 1)

  assert.throws(() => buildPodSpec({ session, lab: { ...gitLab, sourceDir: "../etc" }, routeId: "r", agentToken: "t", config }), /safe sourceDir/)
  assert.equal(podNameFor("JD7_abc"), "llp-jd7abc")
})

test("pod spec: s3 bundle mode downloads the approved bundle in an init container", () => {
  const session = { _id: "jd7abc", ttlSeconds: 3600, expiresAt: 2_000_000 }
  const s3 = { ...config, bundle: { mode: "s3" } }
  const sha256 = "a".repeat(64)
  const url = "https://bucket.s3.us-east-2.amazonaws.com/scenarios/first-commit/bundles/sha256/aaa.tar?X-Amz-Signature=x"
  const spec = buildPodSpec({ session, lab: gitLab, routeId: "r".repeat(24), agentToken: "t", config: s3, bundleDownload: { url, sha256 } })
  assert.deepEqual(spec.spec.volumes[0], { name: "scenario", emptyDir: { sizeLimit: "256Mi" } })
  const [init] = spec.spec.initContainers
  assert.equal(init.image, config.image, "init container defaults to the session image (curl + CA certs)")
  assert.match(init.command[2], /curl -fsS --proto =https/)
  assert.deepEqual(init.env, [
    { name: "BUNDLE_URL", value: url },
    { name: "BUNDLE_SHA256", value: sha256 },
  ])
  assert.match(init.command[2], /sha256sum -c/)
  assert.match(init.command[2], /tar -xf .* -C \/scenario/)
  assert.deepEqual(init.securityContext.capabilities, { drop: ["ALL"] })
  assert.equal(spec.spec.containers[0].volumeMounts[0].readOnly, true)
  assert.equal(buildPodSpec({ session, lab: gitLab, routeId: "r", agentToken: "t", config: { ...config, bundle: { mode: "s3", initImage: "x/busybox:1" } }, bundleDownload: { url, sha256 } }).spec.initContainers[0].image, "x/busybox:1")

  assert.throws(() => buildPodSpec({ session, lab: gitLab, routeId: "r", agentToken: "t", config: s3 }), /presigned download URL/)
  assert.throws(() => buildPodSpec({ session, lab: gitLab, routeId: "r", agentToken: "t", config: s3, bundleDownload: { url, sha256: "nope" } }), /presigned download URL/)
  assert.throws(() => buildPodSpec({ session, lab: gitLab, routeId: "r", agentToken: "t", config: s3, bundleDownload: { url: "http://x/y", sha256 } }), /must be https/)
  assert.throws(() => buildPodSpec({ session, lab: gitLab, routeId: "r", agentToken: "t", config: { ...config, bundle: { mode: "nfs" } } }), /unknown bundle mode/)
})

test("workspace.cwd is only mounted under /workspace or /home/<user>", () => {
  const session = { _id: "jd7abc", ttlSeconds: 3600, expiresAt: 2_000_000 }
  const mountPath = (cwd) =>
    buildPodSpec({ session, lab: { ...gitLab, workspace: { cwd, user: "learner" } }, routeId: "r".repeat(24), agentToken: "t", config }).spec.containers[0].volumeMounts.find((m) => m.name === "workspace").mountPath
  assert.equal(mountPath(undefined), "/workspace")
  assert.equal(mountPath("/workspace"), "/workspace")
  assert.equal(mountPath("/workspace/app/"), "/workspace/app")
  assert.equal(mountPath("/home/learner/project"), "/home/learner/project")
  for (const bad of ["/", "/scenario", "/etc", "/workspace/../etc", "/home", "/homely", "workspace", "/workspace/a b", "/tmp/x", "/workspace/..", "/home/learner/../../etc"]) {
    assert.throws(() => mountPath(bad), /must be under \/workspace or \/home/, bad)
  }
  assert.equal(workspaceMountPath("/workspace/x"), "/workspace/x")
})

test("route ids and endpoint urls", () => {
  assert.match(randomRouteId(), /^[a-z0-9]{24}$/)
  assert.deepEqual(endpointUrls({ routeId: "abc", hostSuffix: "lab.localhost", port: 8080, hasPreview: true }), {
    workspaceUrl: "http://ws-abc.lab.localhost:8080",
    terminalUrl: "http://ws-abc.lab.localhost:8080",
    previewUrl: "http://pv-abc.lab.localhost:8080",
  })
  assert.equal(endpointUrls({ routeId: "abc", hostSuffix: "dev.example.com", scheme: "https", port: 443, hasPreview: false }).previewUrl, undefined)
  assert.equal(endpointUrls({ routeId: "abc", hostSuffix: "dev.example.com", scheme: "https", port: 443, hasPreview: false }).workspaceUrl, "https://ws-abc.dev.example.com")
})

test("requested → starting → pod created → ready → running, idempotently", async () => {
  const convex = fakeConvex()
  const k8s = fakeK8s()
  const id = convex.addSession(reactLab)
  const dispatcher = createDispatcher({ convex, k8s, config, logger: quiet })

  await dispatcher.tick()
  const session = convex.get(id)
  assert.equal(session.status, "starting")
  assert.match(session.routeId, /^[a-z0-9]{24}$/)
  assert.equal(session.podName, "llp-s1")
  assert.equal(session.previewPort, 5173)
  assert.ok(k8s.pods.has("llp-s1"))
  const env = Object.fromEntries(k8s.pods.get("llp-s1").spec.containers[0].env.map((e) => [e.name, e.value]))
  assert.equal(env.SESSION_TOKEN, "t".repeat(64))

  await dispatcher.tick() // still pending: nothing changes, no new pod
  assert.equal(session.status, "starting")
  assert.equal(k8s.pods.size, 1)
  assert.equal(convex.calls.filter(([path]) => path === "sessions:issueAgentToken").length, 1)

  k8s.ready("llp-s1", "10.1.2.3")
  await dispatcher.tick()
  assert.equal(session.status, "running")
  assert.equal(session.podIp, "10.1.2.3")
  assert.equal(session.workspaceUrl, `http://ws-${session.routeId}.lab.localhost:8080`)
  assert.equal(session.previewUrl, `http://pv-${session.routeId}.lab.localhost:8080`)
  assert.equal(dispatcher.stats.launched, 1)
  assert.equal(dispatcher.stats.running, 1)
})

test("routing metadata is persisted before the pod exists, and back-filled from the pod when missing", async () => {
  const convex = fakeConvex()
  const k8s = fakeK8s()
  const id = convex.addSession(reactLab)
  const dispatcher = createDispatcher({ convex, k8s, config, logger: quiet })

  // Convex is down right after the token was issued: nothing is created and
  // the next tick retries from a clean slate (no pod without a known route).
  convex.failNextMetadata = true
  await dispatcher.tick()
  assert.equal(k8s.pods.size, 0)
  assert.equal(convex.get(id).routeId, undefined)
  await dispatcher.tick()
  const session = convex.get(id)
  assert.ok(k8s.pods.has("llp-s1"))
  const order = convex.calls.map(([path]) => path).filter((path) => path === "sessions:updateRunnerMetadata" || path === "sessions:issueAgentToken")
  assert.deepEqual(order.slice(-2), ["sessions:issueAgentToken", "sessions:updateRunnerMetadata"])
  assert.equal(session.podName, "llp-s1")
  assert.equal(session.agentPort, 7000)
  assert.equal(session.previewPort, 5173)
  assert.equal(k8s.pods.get("llp-s1").metadata.labels["learning-lab/route"], session.routeId)

  // Crash after createPod but before metadata was durable (or an old record):
  // the Ready branch restores routeId/podName/ports from the pod itself.
  const routeId = session.routeId
  delete session.routeId
  delete session.podName
  delete session.agentPort
  delete session.previewPort
  k8s.ready("llp-s1", "10.2.3.4")
  await dispatcher.tick()
  assert.equal(session.status, "running")
  assert.equal(session.routeId, routeId)
  assert.equal(session.podName, "llp-s1")
  assert.equal(session.agentPort, 7000)
  assert.equal(session.previewPort, 5173)
  assert.equal(session.podIp, "10.2.3.4")
  assert.equal(session.workspaceUrl, `http://ws-${routeId}.lab.localhost:8080`)
  assert.equal(k8s.pods.size, 1)
})

test("a running session whose pod vanished or finished is errored", async () => {
  const convex = fakeConvex()
  const k8s = fakeK8s()
  const gone = convex.addSession(gitLab, { status: "running", podName: "llp-gone", routeId: "r".repeat(24) })
  const finished = convex.addSession(gitLab, { status: "checking", podName: "llp-finished", routeId: "s".repeat(24) })
  const healthy = convex.addSession(gitLab, { status: "passed", podName: "llp-healthy", routeId: "t".repeat(24) })
  const starting = convex.addSession(gitLab, { status: "starting", podName: "llp-starting", routeId: "u".repeat(24) })
  for (const name of ["llp-finished", "llp-healthy"]) {
    await k8s.createPod({ metadata: { name, labels: { [SESSION_LABEL]: SESSION_LABEL_VALUE, [SESSION_ID_LABEL]: name === "llp-healthy" ? healthy : finished } }, spec: {} })
    k8s.ready(name)
  }
  k8s.pods.get("llp-finished").status.phase = "Succeeded"
  const dispatcher = createDispatcher({ convex, k8s, config, logger: quiet })
  await dispatcher.tick()
  assert.equal(convex.get(gone).status, "errored")
  assert.match(convex.get(gone).error, /llp-gone is gone/)
  assert.equal(convex.get(finished).status, "errored")
  assert.match(convex.get(finished).error, /llp-finished is gone \(succeeded\)/)
  assert.ok(!k8s.pods.has("llp-finished"), "the finished pod is deleted")
  assert.equal(convex.get(healthy).status, "passed")
  assert.ok(k8s.pods.has("llp-healthy"))
  // Starting sessions are the startable path's business (it relaunched a pod).
  assert.equal(convex.get(starting).status, "starting")
  assert.ok(k8s.pods.has(`llp-${starting}`))
  assert.equal(dispatcher.stats.errored, 2)
})

test("a pod that fails or never becomes ready errors the session and is removed", async () => {
  const convex = fakeConvex()
  const k8s = fakeK8s()
  const failing = convex.addSession(gitLab)
  const slow = convex.addSession(gitLab)
  let clock = 1000
  convex.now = () => clock
  const dispatcher = createDispatcher({ convex, k8s, config: { ...config, startupTimeoutMs: 5000 }, logger: quiet, now: () => clock })

  await dispatcher.tick()
  k8s.fail(`llp-${failing}`)
  await dispatcher.tick()
  assert.equal(convex.get(failing).status, "errored")
  assert.match(convex.get(failing).error, /failed before it became ready/)
  assert.ok(!k8s.pods.has(`llp-${failing}`))

  clock = 1000 + 6000
  await dispatcher.tick()
  assert.equal(convex.get(slow).status, "errored")
  assert.match(convex.get(slow).error, /did not become ready within 5 s/)
})

test("cleanup deletes pods, orphans are reaped, lease loss skips work", async () => {
  const convex = fakeConvex()
  const k8s = fakeK8s()
  const stopped = convex.addSession(gitLab, { status: "stopping", podName: "llp-x" })
  await k8s.createPod({ metadata: { name: "llp-x", labels: { [SESSION_LABEL]: SESSION_LABEL_VALUE, [SESSION_ID_LABEL]: stopped } }, spec: {} })
  await k8s.createPod({ metadata: { name: "llp-orphan", labels: { [SESSION_LABEL]: SESSION_LABEL_VALUE, [SESSION_ID_LABEL]: "gone" } }, spec: {} })
  k8s.pods.get("llp-orphan").metadata.creationTimestamp = new Date(Date.now() - 120_000).toISOString()
  const dispatcher = createDispatcher({ convex, k8s, config, logger: quiet })
  await dispatcher.tick()
  assert.equal(convex.get(stopped).status, "stopped")
  assert.match(convex.get(stopped).cleanupSummary, /deleted/)
  assert.ok(!k8s.pods.has("llp-x"))
  assert.ok(!k8s.pods.has("llp-orphan"))
  assert.equal(dispatcher.stats.orphansDeleted, 1)

  const follower = createDispatcher({ convex: fakeConvex({ leaseHeld: false }), k8s, config, logger: quiet })
  assert.deepEqual(await follower.tick(), { skipped: "lease" })
})

test("podIsReady needs both the Ready condition and an IP", () => {
  assert.equal(podIsReady({ status: { podIP: "1.1.1.1", conditions: [{ type: "Ready", status: "True" }] } }), true)
  assert.equal(podIsReady({ status: { conditions: [{ type: "Ready", status: "True" }] } }), false)
  assert.equal(podIsReady({ status: { podIP: "1.1.1.1", conditions: [{ type: "Ready", status: "False" }] } }), false)
  assert.equal(podIsReady(null), false)
})

test("s3 bundle mode: launches with a presigned bundle, errors sessions without an approval", async () => {
  const convex = fakeConvex()
  const k8s = fakeK8s()
  const presigned = []
  const dispatcher = createDispatcher({
    convex,
    k8s,
    config: { ...config, bundle: { mode: "s3" } },
    logger: { info() {}, warn() {}, error() {} },
    presignBundle: async ({ key, sha256 }) => {
      presigned.push({ key, sha256 })
      return `https://bundles.s3.us-east-2.amazonaws.com/${key}?X-Amz-Signature=sig`
    },
  })
  const sha256 = "b".repeat(64)
  const approved = convex.addSession(gitLab, {
    hostedScenario: { artifactKey: `scenarios/first-commit/bundles/sha256/${sha256}.tar`, artifactSha256: sha256 },
  })
  const unapproved = convex.addSession(reactLab)
  await dispatcher.tick()

  const pod = k8s.pods.get(`llp-${approved}`)
  assert.ok(pod, "approved session got a pod")
  assert.deepEqual(presigned, [{ key: `scenarios/first-commit/bundles/sha256/${sha256}.tar`, sha256 }])
  assert.equal(pod.spec.initContainers[0].env[0].value, `https://bundles.s3.us-east-2.amazonaws.com/scenarios/first-commit/bundles/sha256/${sha256}.tar?X-Amz-Signature=sig`)
  assert.equal(pod.spec.volumes[0].emptyDir.sizeLimit, "256Mi")

  assert.equal(k8s.pods.has(`llp-${unapproved}`), false)
  assert.equal(convex.get(unapproved).status, "errored")
  assert.match(convex.get(unapproved).error, /no approved scenario bundle/)
  assert.ok(!convex.calls.some(([path, args]) => path === "sessions:issueAgentToken" && args.sessionId === unapproved), "no agent token issued for an unlaunchable session")
})

test("s3 bundle mode: a transient presign failure is retried next tick, not errored", async () => {
  const convex = fakeConvex()
  const k8s = fakeK8s()
  const errors = []
  let failures = 1
  const dispatcher = createDispatcher({
    convex,
    k8s,
    config: { ...config, bundle: { mode: "s3" } },
    logger: { info() {}, warn() {}, error: (message) => errors.push(message) },
    presignBundle: async ({ key }) => {
      if (failures-- > 0) throw new Error("container credentials endpoint returned 500")
      return `https://bundles.s3.us-east-2.amazonaws.com/${key}?X-Amz-Signature=sig`
    },
  })
  const sha256 = "c".repeat(64)
  const id = convex.addSession(gitLab, {
    hostedScenario: { artifactKey: `scenarios/first-commit/bundles/sha256/${sha256}.tar`, artifactSha256: sha256 },
  })
  await dispatcher.tick()
  assert.equal(convex.get(id).status, "starting", "still startable after a credential error")
  assert.equal(k8s.pods.has(`llp-${id}`), false)
  assert.ok(errors.some((message) => /credentials endpoint returned 500/.test(message)), "the failure is logged")

  await dispatcher.tick()
  assert.ok(k8s.pods.has(`llp-${id}`), "launched on the next tick")
  assert.notEqual(convex.get(id).status, "errored")
})

test("s3 bundle mode: a presign failure past the startup timeout errors the session", async () => {
  const convex = fakeConvex()
  const k8s = fakeK8s()
  let clock = 1000
  convex.now = () => clock
  const dispatcher = createDispatcher({
    convex,
    k8s,
    config: { ...config, bundle: { mode: "s3" }, startupTimeoutMs: 60_000 },
    logger: quiet,
    now: () => clock,
    presignBundle: async () => {
      throw new Error("container credentials endpoint returned 500")
    },
  })
  const sha256 = "d".repeat(64)
  const id = convex.addSession(gitLab, {
    hostedScenario: { artifactKey: `scenarios/first-commit/bundles/sha256/${sha256}.tar`, artifactSha256: sha256 },
  })
  await dispatcher.tick()
  assert.equal(convex.get(id).status, "starting")
  clock += 61_000
  await dispatcher.tick()
  assert.equal(convex.get(id).status, "errored")
  assert.match(convex.get(id).error, /Scenario bundle unavailable: container credentials/)
})

test("s3 bundle mode: the pod follows the approved runtime contract, not the live labs row", async () => {
  const convex = fakeConvex()
  const k8s = fakeK8s()
  const dispatcher = createDispatcher({
    convex,
    k8s,
    config: { ...config, bundle: { mode: "s3" } },
    logger: quiet,
    presignBundle: async ({ key }) => `https://bundles.s3.us-east-2.amazonaws.com/${key}?X-Amz-Signature=sig`,
  })
  const sha256 = "e".repeat(64)
  // The labs row now says terminal-only; the approved bundle is the React one.
  const id = convex.addSession(gitLab, {
    hostedScenario: {
      artifactKey: `scenarios/first-commit/bundles/sha256/${sha256}.tar`,
      artifactSha256: sha256,
      runtime: {
        kind: "react",
        ttlSeconds: 3600,
        workspace: { cwd: "/home/learner/app", user: "learner" },
        tabs: ["terminal", "preview"],
        stepCount: 2,
        react: { previewPort: 5174 },
      },
    },
  })
  await dispatcher.tick()
  const pod = k8s.pods.get(`llp-${id}`)
  assert.ok(pod)
  assert.deepEqual(pod.spec.containers[0].ports.map((port) => port.containerPort), [7000, 5174])
  assert.ok(pod.spec.containers[0].volumeMounts.some((mount) => mount.name === "workspace" && mount.mountPath === "/home/learner/app"))
  assert.equal(pod.metadata.labels["learning-lab/scenario"], "first-commit", "slug still comes from the labs row")
  assert.equal(convex.get(id).previewPort, 5174)

  k8s.ready(`llp-${id}`)
  await dispatcher.tick()
  assert.equal(convex.get(id).status, "running")
  assert.match(convex.get(id).previewUrl, /^http:\/\/pv-/)
})

test("hostPath mode ignores hostedScenario.runtime; pods opt out of Auto Mode consolidation", async () => {
  const convex = fakeConvex()
  const k8s = fakeK8s()
  const dispatcher = createDispatcher({ convex, k8s, config, logger: quiet })
  const id = convex.addSession(gitLab, { hostedScenario: { runtime: { kind: "react", react: { previewPort: 5174 } } } })
  await dispatcher.tick()
  const pod = k8s.pods.get(`llp-${id}`)
  assert.deepEqual(pod.spec.containers[0].ports.map((port) => port.containerPort), [7000])
  assert.equal(pod.metadata.annotations["karpenter.sh/do-not-disrupt"], "true")
})

test("podFailureDetail names the container that died", () => {
  assert.equal(podFailureDetail({ status: { phase: "Failed" } }), "")
  assert.equal(
    podFailureDetail({
      status: {
        initContainerStatuses: [{ name: "bundle", state: { terminated: { exitCode: 1, reason: "Error" } } }],
        containerStatuses: [{ name: "workspace", state: { waiting: {} } }],
      },
    }),
    " (bundle exited 1)",
  )
  assert.equal(
    podFailureDetail({ status: { containerStatuses: [{ name: "workspace", lastState: { terminated: { exitCode: 137, reason: "OOMKilled" } } }] } }),
    " (workspace exited 137: OOMKilled)",
  )
  assert.equal(podFailureDetail({ status: { reason: "Evicted" } }), " (Evicted)")
})
