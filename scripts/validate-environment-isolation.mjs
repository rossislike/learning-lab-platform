import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

const defaultRegistryUrl = new URL("../config/hosted-environments.json", import.meta.url)
const requiredEnvironments = ["development", "staging", "production"]
const hostedEnvironments = ["staging", "production"]
const identityFields = ["awsAccountId", "clerkApplicationId", "convexDeployment"]
const sharedAwsAccountId = "442359104502"
const requiredIsolationBoundaries = new Set([
  "terraformState",
  "resourceNames",
  "network",
  "iam",
  "kms",
  "ecr",
  "objectStorage",
  "secrets",
])

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isNonemptyString(value) {
  return typeof value === "string" && value.trim() === value && value.length > 0
}

function validIdentity(field, value) {
  if (value === null) return true
  if (!isNonemptyString(value)) return false
  if (field === "awsAccountId") return /^[0-9]{12}$/.test(value)
  if (field === "clerkApplicationId") return /^app_[A-Za-z0-9]+$/.test(value)
  return /^(dev|prod):[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(value)
}

function sameMembers(values, expected) {
  return Array.isArray(values) && values.length === expected.size &&
    new Set(values).size === values.length && values.every((value) => expected.has(value))
}

export function validateIsolationRegistry(registry) {
  const errors = []
  const blockers = []

  if (!isRecord(registry)) return { blockers, errors: ["registry must be an object"], ready: false }
  if (registry.schemaVersion !== 2) errors.push("schemaVersion must be 2")
  if (!isRecord(registry.environments)) errors.push("environments must be an object")

  for (const environment of requiredEnvironments) {
    const config = registry.environments?.[environment]
    if (!isRecord(config)) {
      errors.push(`environments.${environment} must be an object`)
      continue
    }
    for (const field of identityFields) {
      if (!(field in config)) errors.push(`${environment}.${field} is required`)
      else if (!validIdentity(field, config[field])) {
        errors.push(`${environment}.${field} has an invalid type or format`)
      }
    }
  }

  const topology = registry.awsAccountTopology
  if (!isRecord(topology)) {
    errors.push("awsAccountTopology must be an object")
  } else {
    if (topology.mode !== "shared") errors.push("awsAccountTopology.mode must be shared")
    if (!sameMembers(topology.environments, new Set(hostedEnvironments))) {
      errors.push("awsAccountTopology.environments must contain exactly staging and production")
    }
    if (!sameMembers(topology.isolationBoundaries, requiredIsolationBoundaries)) {
      errors.push("awsAccountTopology.isolationBoundaries must contain every required shared-account boundary")
    }
    if (!isNonemptyString(topology.owner)) errors.push("awsAccountTopology.owner must be a nonempty string")
    if (!isNonemptyString(topology.reason)) errors.push("awsAccountTopology.reason must be a nonempty string")
    if (topology.sharedAccountId !== sharedAwsAccountId) {
      errors.push(`awsAccountTopology.sharedAccountId must be ${sharedAwsAccountId}`)
    }
  }

  for (const field of identityFields) {
    const configured = new Map()
    for (const environment of requiredEnvironments) {
      const value = registry.environments?.[environment]?.[field]
      if (value === null && environment !== "development") blockers.push(`${environment}.${field} is not configured`)
      if (typeof value === "string" && value.length > 0) {
        if (configured.has(value)) {
          const environments = [configured.get(value), environment].sort()
          const allowedSharedAwsAccount = field === "awsAccountId" &&
            topology?.mode === "shared" && value === sharedAwsAccountId &&
            environments.join(",") === "production,staging"
          if (!allowedSharedAwsAccount) {
            errors.push(`${environment}.${field} duplicates ${configured.get(value)}.${field}`)
          }
        } else configured.set(value, environment)
      }
    }
  }

  const stagingAccountId = registry.environments?.staging?.awsAccountId
  const productionAccountId = registry.environments?.production?.awsAccountId
  if (
    stagingAccountId !== topology?.sharedAccountId || productionAccountId !== topology?.sharedAccountId
  ) {
    errors.push("staging and production AWS accounts must match awsAccountTopology.sharedAccountId")
  }

  if (typeof registry.productionLearnerTrafficBlocked !== "boolean") {
    errors.push("productionLearnerTrafficBlocked must be boolean")
  } else if (blockers.length > 0 && registry.productionLearnerTrafficBlocked !== true) {
    errors.push("productionLearnerTrafficBlocked must remain true while hosted identities are incomplete")
  }

  return { blockers, errors, ready: errors.length === 0 && blockers.length === 0 }
}

export function validateAwsInfrastructureRegistry(registry, environment) {
  const validation = validateIsolationRegistry(registry)
  const blockers = validation.blockers.filter((blocker) => blocker.includes(".awsAccountId "))
  return {
    blockers,
    errors: validation.errors,
    ready: validation.errors.length === 0 && blockers.length === 0 &&
      typeof registry?.environments?.[environment]?.awsAccountId === "string",
  }
}

export async function loadIsolationRegistry(registryUrl = defaultRegistryUrl) {
  return JSON.parse(await readFile(registryUrl, "utf8"))
}

export async function runCli(args = process.argv.slice(2)) {
  if (args.some((arg) => arg !== "--require-ready") || args.filter((arg) => arg === "--require-ready").length > 1) {
    console.error("usage: validate-environment-isolation.mjs [--require-ready]")
    return 2
  }
  let registry
  try {
    registry = await loadIsolationRegistry()
  } catch (error) {
    console.error(`error: unable to load environment registry: ${error.message}`)
    return 1
  }
  const result = validateIsolationRegistry(registry)
  for (const error of result.errors) console.error(`error: ${error}`)
  for (const blocker of result.blockers) console.log(`blocked: ${blocker}`)
  if (result.errors.length > 0 || (args.includes("--require-ready") && !result.ready)) return 1
  console.log(result.ready ? "Hosted environment identities satisfy the configured isolation topology." : "Environment registry is valid but not hosted-ready.")
  return 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await runCli()
