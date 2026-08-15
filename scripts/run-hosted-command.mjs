import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import { loadIsolationRegistry, validateAwsInfrastructureRegistry, validateIsolationRegistry } from "./validate-environment-isolation.mjs"

const environments = new Set(["staging", "production"])
const terraformActions = new Set(["plan", "apply"])

function execute(command, args, options = {}) {
  return spawnSync(command, args, { stdio: "inherit", ...options }).status ?? 1
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
  const [tool, action, environment, separator, ...forwarded] = args
  const expectedSeparator = forwarded.length > 0 ? "--" : undefined
  const validTerraform = tool === "terraform" && terraformActions.has(action) && environments.has(environment)
  const validConvex = tool === "convex" && action === "deploy" && environments.has(environment)
  if ((!validTerraform && !validConvex) || (separator !== expectedSeparator && separator !== undefined)) {
    console.error("usage: run-hosted-command.mjs terraform <plan|apply> <staging|production> [-- args...] | convex deploy <staging|production> [-- args...]")
    return 2
  }

  const registry = await (deps.loadRegistry ?? loadIsolationRegistry)()
  const validation = validTerraform
    ? validateAwsInfrastructureRegistry(registry, environment)
    : validateIsolationRegistry(registry)
  if (!validation.ready) {
    for (const issue of [...validation.errors, ...validation.blockers]) console.error(`blocked: ${issue}`)
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
      console.error(`blocked: active AWS account does not match registry for ${environment}`)
      return 1
    }
    return run(
      "terraform",
      [`-chdir=infra/aws/environments/${environment}`, action, `-var=expected_aws_account_id=${config.awsAccountId}`, ...forwarded],
      { env: awsEnvironment },
    )
  }

  if (process.env.CONVEX_DEPLOYMENT !== config.convexDeployment) {
    console.error(`blocked: CONVEX_DEPLOYMENT does not match registry for ${environment}`)
    return 1
  }
  return run("npx", ["convex", "deploy", ...forwarded])
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await runHostedCommand()
