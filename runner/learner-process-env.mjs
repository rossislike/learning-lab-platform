const blockedEnvironmentNames = new Set([
  "AWS_ACCESS_KEY_ID",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "ECS_AGENT_URI",
  "ECS_CONTAINER_METADATA_URI",
  "ECS_CONTAINER_METADATA_URI_V4",
  "RUNNER_SECRET_STDIN",
  "RUNNER_SHARED_SECRET",
])

export function learnerProcessEnv(environment = process.env, overrides = {}) {
  const sanitized = Object.fromEntries(
    Object.entries(environment).filter(
      ([name, value]) => value !== undefined && !blockedEnvironmentNames.has(name),
    ),
  )

  return { ...sanitized, ...overrides }
}
