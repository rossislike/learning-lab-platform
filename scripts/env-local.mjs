import { readFile } from "node:fs/promises"

export function parseEnvValue(contents, name) {
  const line = contents
    .split(/\r?\n/)
    .find((entry) => entry.trimStart().startsWith(`${name}=`))
  if (!line) return undefined
  const value = line.slice(line.indexOf("=") + 1).trim()
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1)
  }
  return value
}

export async function readEnvLocalValue(name, url) {
  try {
    return parseEnvValue(await readFile(url, "utf8"), name)
  } catch {
    return undefined
  }
}

/** The ignored `.env.dev` the dev deploy scripts read (docs/dev-environment.md). */
export const envDevUrl = new URL("../.env.dev", import.meta.url)

/**
 * Convex CLI target for the dev deployment. With CONVEX_DEPLOY_KEY (env or
 * `.env.dev`) the CLI runs against exactly the deployment the key belongs to,
 * so `--prod` is dropped; without one, `--prod` picks the prod deployment of
 * the project in `.env.local`'s CONVEX_DEPLOYMENT.
 */
export async function convexTarget() {
  const deployKey = process.env.CONVEX_DEPLOY_KEY ?? (await readEnvLocalValue("CONVEX_DEPLOY_KEY", envDevUrl))
  return {
    deployKey,
    env: deployKey ? { CONVEX_DEPLOY_KEY: deployKey } : {},
    args: (args) => (deployKey ? args.filter((arg) => arg !== "--prod") : args),
  }
}
