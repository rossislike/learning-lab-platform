const checks = [
  ["editor", Number(process.env.LAB_EDITOR_PORT ?? 3000), "/"],
  ["preview", Number(process.env.LAB_PREVIEW_PORT ?? 5173), "/"],
  ["tools", Number(process.env.LAB_TOOLS_PORT ?? 8080), "/api/health"],
]

async function check(name, port, path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    redirect: "manual",
  })

  if (response.status < 200 || response.status >= 500) {
    throw new Error(`${name} returned HTTP ${response.status}`)
  }
}

await Promise.all(checks.map(([name, port, path]) => check(name, port, path)))
