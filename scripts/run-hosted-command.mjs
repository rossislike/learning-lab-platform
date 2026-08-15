import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import { loadIsolationRegistry, validateAwsInfrastructureRegistry, validateIsolationRegistry } from "./validate-environment-isolation.mjs"

const environments = new Set(["staging", "production"])
const terraformActions = new Set(["plan", "apply"])
const forbiddenConvexDeployFlags = new Set([
  "--admin-key",
  "--deployment",
  "--deployment-name",
  "--env-file",
  "--preview-create",
  "--preview-name",
  "--preview-run",
  "--prod",
  "--url",
])
const convexConflictingTargetVariables = [
  "CONVEX_DEPLOYMENT",
  "CONVEX_DEPLOYMENT_TOKEN",
  "CONVEX_SELF_HOSTED_ADMIN_KEY",
  "CONVEX_SELF_HOSTED_URL",
]

function execute(command, args, options = {}) {
  return spawnSync(command, args, { stdio: "inherit", ...options }).status ?? 1
}

function executeCapture(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", ...options })
}

function hasForbiddenConvexDeployFlag(args) {
  return args.some((arg) => forbiddenConvexDeployFlags.has(arg.split("=", 1)[0]))
}

function validatedConvexDeployKey(source, deployment) {
  const deployKey = source.CONVEX_DEPLOY_KEY
  if (typeof deployKey !== "string" || deployKey.trim() !== deployKey) return null
  const separatorIndex = deployKey.indexOf("|")
  if (
    separatorIndex <= 0 || separatorIndex === deployKey.length - 1 ||
    separatorIndex !== deployKey.lastIndexOf("|")
  ) return null
  return deployKey.slice(0, separatorIndex + 1) === `${deployment}|` ? deployKey : null
}

function convexCommandEnvironment(source, deployKey) {
  const environment = { ...source, CONVEX_DEPLOY_KEY: deployKey }
  for (const key of convexConflictingTargetVariables) environment[key] = ""
  return environment
}

function defaultAwsProfileEnvironment(source = process.env) {
  const environment = {
    ...source,
    AWS_DEFAULT_PROFILE: "default",
    AWS_PROFILE: "default",
    AWS_SDK_LOAD_CONFIG: "1",
  }
  for (const key of [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_SECURITY_TOKEN",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_ROLE_ARN",
    "AWS_ROLE_SESSION_NAME",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  ]) delete environment[key]
  return environment
}

export async function runHostedCommand(args = process.argv.slice(2), deps = {}) {
  const reportError = deps.reportError ?? ((message) => console.error(message))
  const [tool, action, environment, separator, ...forwarded] = args
  const expectedSeparator = forwarded.length > 0 ? "--" : undefined
  const validTerraform = tool === "terraform" && terraformActions.has(action) && environments.has(environment)
  const validConvex = tool === "convex" && action === "deploy" && environments.has(environment)
  if ((!validTerraform && !validConvex) || (separator !== expectedSeparator && separator !== undefined)) {
    reportError("usage: run-hosted-command.mjs terraform <plan|apply> <staging|production> [-- args...] | convex deploy <staging|production> [-- args...]")
    return 2
  }
  if (validConvex && hasForbiddenConvexDeployFlag(forwarded)) {
    reportError("blocked: forwarded Convex arguments cannot override or select a deployment target")
    return 2
  }

  const registry = await (deps.loadRegistry ?? loadIsolationRegistry)()
  const validation = validTerraform
    ? validateAwsInfrastructureRegistry(registry, environment)
    : validateIsolationRegistry(registry)
  if (!validation.ready) {
    for (const issue of [...validation.errors, ...validation.blockers]) reportError(`blocked: ${issue}`)
    return 1
  }

  const config = registry.environments[environment]
  const run = deps.execute ?? execute
  if (validTerraform) {
    const awsEnvironment = defaultAwsProfileEnvironment(deps.environment ?? process.env)
    const getAwsAccountId = deps.getAwsAccountId ?? ((commandEnvironment) => {
      const result = spawnSync("aws", ["sts", "get-caller-identity", "--query", "Account", "--output", "text"], {
        encoding: "utf8",
        env: commandEnvironment,
      })
      return result.status === 0 ? result.stdout.trim() : null
    })
    const identity = deps.awsAccountId ?? getAwsAccountId(awsEnvironment)
    if (identity !== config.awsAccountId) {
      reportError(`blocked: active AWS account does not match registry for ${environment}`)
      return 1
    }
    return run(
      "terraform",
      [`-chdir=infra/aws/environments/${environment}`, action, `-var=expected_aws_account_id=${config.awsAccountId}`, ...forwarded],
      { env: awsEnvironment },
    )
  }

  const sourceEnvironment = deps.environment ?? process.env
  if (convexConflictingTargetVariables.some((key) => sourceEnvironment[key])) {
    reportError("blocked: conflicting Convex deployment selectors must be unset")
    return 1
  }
  const deployKey = validatedConvexDeployKey(sourceEnvironment, config.convexDeployment)
  if (deployKey === null) {
    reportError(`blocked: CONVEX_DEPLOY_KEY must be scoped to the registered ${environment} deployment`)
    return 1
  }

  const commandEnvironment = convexCommandEnvironment(sourceEnvironment, deployKey)
  const inspect = deps.executeCapture ?? executeCapture
  const issuerResult = inspect(
    "npx",
    [
      "convex",
      "env",
      "get",
      "CLERK_JWT_ISSUER_DOMAIN",
    ],
    { env: commandEnvironment },
  )
  if (issuerResult.status !== 0) {
    reportError(`blocked: unable to verify the Convex Clerk issuer for ${environment}`)
    return 1
  }
  if (typeof issuerResult.stdout !== "string" || issuerResult.stdout.trim() !== config.clerk.issuerDomain) {
    reportError(`blocked: Convex Clerk issuer does not match registry for ${environment}`)
    return 1
  }
  return run("npx", ["convex", "deploy", ...forwarded], { env: commandEnvironment })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await runHostedCommand()
