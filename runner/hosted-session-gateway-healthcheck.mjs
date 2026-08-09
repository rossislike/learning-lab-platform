const port = Number(process.env.SESSION_GATEWAY_PORT ?? 8080)
const controller = new AbortController()
const timeout = setTimeout(() => controller.abort(), 4000)

try {
  const response = await fetch(`http://127.0.0.1:${port}/health`, {
    signal: controller.signal,
  })
  if (!response.ok) process.exitCode = 1
} catch {
  process.exitCode = 1
} finally {
  clearTimeout(timeout)
}
