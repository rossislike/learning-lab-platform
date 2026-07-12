import {
  DescribeTasksCommand,
  ECSClient,
  ListTasksCommand,
  StopTaskCommand,
} from "@aws-sdk/client-ecs"

const configuredCluster = process.env.ECS_CLUSTER_ARN
const configuredMaxRuntimeSeconds = Number(
  process.env.MAX_MANAGED_RUNTIME_SECONDS ?? 28800,
)
const client = new ECSClient({})
const describeBatchSize = 100
const stopConcurrency = 20

function tagsByKey(tags = []) {
  return Object.fromEntries(tags.map(({ key, value }) => [key, value]))
}

async function listRunningTaskArns(ecs, cluster) {
  const taskArns = []
  let nextToken

  do {
    const response = await ecs.send(
      new ListTasksCommand({
        cluster,
        desiredStatus: "RUNNING",
        nextToken,
      }),
    )
    taskArns.push(...(response.taskArns ?? []))
    nextToken = response.nextToken
  } while (nextToken)

  return taskArns
}

function stopReason(task, now, maxRuntimeMs) {
  const tags = tagsByKey(task.tags)
  if (tags["learning-lab:managed"] !== "true") return undefined

  const rawExpiry = tags["learning-lab:expires-at"]
  const expiresAt =
    typeof rawExpiry === "string" ? Date.parse(rawExpiry) : Number.NaN
  const canonicalExpiry =
    Number.isFinite(expiresAt) && new Date(expiresAt).toISOString() === rawExpiry
  const createdAt = new Date(task.createdAt ?? Number.NaN).getTime()
  if (canonicalExpiry) {
    if (expiresAt <= now) return `Learning Lab TTL expired at ${rawExpiry}`
    if (!Number.isFinite(createdAt)) {
      return `Learning Lab fail-safe TTL stopped task with invalid creation time and expiry tag: ${rawExpiry}`
    }
    if (expiresAt <= createdAt + maxRuntimeMs) return undefined
  }

  if (!Number.isFinite(createdAt)) {
    return `Learning Lab fail-safe TTL stopped task with invalid creation time and expiry tag: ${rawExpiry ?? "missing"}`
  }
  if (Number.isFinite(createdAt) && createdAt + maxRuntimeMs <= now) {
    return `Learning Lab fail-safe TTL exceeded after invalid or excessive expiry tag: ${rawExpiry ?? "missing"}`
  }

  return null
}

async function stopTasks(ecs, cluster, candidates) {
  const stopped = []
  const stopFailures = []

  for (let offset = 0; offset < candidates.length; offset += stopConcurrency) {
    const batch = candidates.slice(offset, offset + stopConcurrency)
    const results = await Promise.allSettled(
      batch.map(({ taskArn, reason }) =>
        ecs.send(new StopTaskCommand({ cluster, task: taskArn, reason })),
      ),
    )

    results.forEach((result, index) => {
      const taskArn = batch[index].taskArn
      if (result.status === "fulfilled") stopped.push(taskArn)
      else stopFailures.push({ taskArn, error: String(result.reason) })
    })
  }

  return { stopped, stopFailures }
}

export async function handler(_event, _context, dependencies = {}) {
  const cluster = dependencies.cluster ?? configuredCluster
  if (!cluster) throw new Error("ECS_CLUSTER_ARN is required")

  const ecs = dependencies.client ?? client
  const now = dependencies.now?.() ?? Date.now()
  const maxRuntimeSeconds =
    dependencies.maxRuntimeSeconds ?? configuredMaxRuntimeSeconds
  if (!Number.isFinite(maxRuntimeSeconds) || maxRuntimeSeconds < 300) {
    throw new Error("MAX_MANAGED_RUNTIME_SECONDS must be at least 300")
  }

  const taskArns = await listRunningTaskArns(ecs, cluster)
  const candidates = []
  const malformed = []
  const describeFailures = []

  for (let offset = 0; offset < taskArns.length; offset += describeBatchSize) {
    const batch = taskArns.slice(offset, offset + describeBatchSize)
    const response = await ecs.send(
      new DescribeTasksCommand({ cluster, tasks: batch, include: ["TAGS"] }),
    )
    describeFailures.push(...(response.failures ?? []))

    for (const task of response.tasks ?? []) {
      if (!task.taskArn) continue
      const reason = stopReason(task, now, maxRuntimeSeconds * 1000)
      if (reason === null) {
        malformed.push(task.taskArn)
        continue
      }
      if (reason) candidates.push({ taskArn: task.taskArn, reason })
    }
  }

  const { stopped, stopFailures } = await stopTasks(ecs, cluster, candidates)
  const result = {
    scanned: taskArns.length,
    stopped,
    malformed,
    describeFailures,
    stopFailures,
  }
  if (malformed.length > 0) {
    console.warn(JSON.stringify({ message: "Managed tasks have invalid TTL tags", malformed }))
  }
  console.log(JSON.stringify(result))
  if (describeFailures.length > 0 || stopFailures.length > 0) {
    console.error(
      JSON.stringify({
        message: "TTL cleanup encountered ECS API failures",
        describeFailures,
        stopFailures,
      }),
    )
    throw new Error("TTL cleanup encountered ECS API failures")
  }
  return result
}
