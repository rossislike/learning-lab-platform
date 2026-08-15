import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

const defaultRegistryUrl = new URL("../config/hosted-environments.json", import.meta.url)
const requiredEnvironments = ["development", "staging", "production"]
const hostedEnvironments = ["staging", "production"]
const identityFields = ["awsAccountId", "convexDeployment"]
const clerkIdentityFields = ["applicationId", "instanceId", "instanceType", "issuerDomain"]
const sharedAwsAccountId = "442359104502"
const sharedClerkEnvironments = new Set(["development", "staging"])
const sharedClerkIdentity = Object.freeze({
  applicationId: "app_3GKhzAioaTZbOK6QwVEL8qxIHS3",
  instanceId: "ins_3GKhzB4WHOIij3p0UthvLWPmVCG",
  instanceType: "development",
  issuerDomain: "https://amazed-adder-35.clerk.accounts.dev",
})
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
  return /^(dev|prod):[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(value)
}

function validIssuerDomain(value) {
  if (!isNonemptyString(value)) return false
  try {
    const issuer = new URL(value)
    return issuer.protocol === "https:" && issuer.origin === value
  } catch {
    return false
  }
}

function sameMembers(values, expected) {
  return Array.isArray(values) && values.length === expected.size &&
    new Set(values).size === values.length && values.every((value) => expected.has(value))
}

function isPinnedSharedClerkTopology(topology) {
  return isRecord(topology) && topology.mode === "sharedDevelopmentStaging" &&
    sameMembers(topology.environments, sharedClerkEnvironments) &&
    clerkIdentityFields.every((field) => topology[field] === sharedClerkIdentity[field])
}

function validateClerkIdentity(identity, environment, errors) {
  if (!isRecord(identity)) {
    errors.push(`${environment}.clerk must be an object or null`)
    return
  }

  for (const field of clerkIdentityFields) {
    if (!(field in identity)) errors.push(`${environment}.clerk.${field} is required`)
  }
  if (!isNonemptyString(identity.applicationId) || !/^app_[A-Za-z0-9]+$/.test(identity.applicationId)) {
    errors.push(`${environment}.clerk.applicationId must be a valid Clerk application ID`)
  }
  if (!isNonemptyString(identity.instanceId) || !/^ins_[A-Za-z0-9]+$/.test(identity.instanceId)) {
    errors.push(`${environment}.clerk.instanceId must be a valid Clerk instance ID`)
  }
  const expectedInstanceType = environment === "production" ? "production" : "development"
  if (identity.instanceType !== expectedInstanceType) {
    errors.push(`${environment}.clerk.instanceType must be ${expectedInstanceType}`)
  }
  if (!validIssuerDomain(identity.issuerDomain)) {
    errors.push(`${environment}.clerk.issuerDomain must be an HTTPS origin without a path`)
  } else if (
    identity.instanceType === "development" &&
    !new URL(identity.issuerDomain).hostname.endsWith(".clerk.accounts.dev")
  ) {
    errors.push(`${environment}.clerk.issuerDomain must use Clerk's development issuer format`)
  }
}

export function validateIsolationRegistry(registry) {
  const errors = []
  const blockers = []

  if (!isRecord(registry)) return { blockers, errors: ["registry must be an object"], ready: false }
  if (registry.schemaVersion !== 3) errors.push("schemaVersion must be 3")
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
    if (!("clerk" in config)) {
      errors.push(`${environment}.clerk is required`)
    } else if (config.clerk === null) {
      blockers.push(`${environment}.clerk is not configured`)
    } else {
      validateClerkIdentity(config.clerk, environment, errors)
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

  const clerkTopology = registry.clerkApplicationTopology
  if (!isRecord(clerkTopology)) {
    errors.push("clerkApplicationTopology must be an object")
  } else {
    if (clerkTopology.mode !== "sharedDevelopmentStaging") {
      errors.push("clerkApplicationTopology.mode must be sharedDevelopmentStaging")
    }
    if (!sameMembers(clerkTopology.environments, sharedClerkEnvironments)) {
      errors.push("clerkApplicationTopology.environments must contain exactly development and staging")
    }
    for (const field of clerkIdentityFields) {
      if (clerkTopology[field] !== sharedClerkIdentity[field]) {
        errors.push(`clerkApplicationTopology.${field} must be ${sharedClerkIdentity[field]}`)
      }
    }
    if (!isNonemptyString(clerkTopology.owner)) {
      errors.push("clerkApplicationTopology.owner must be a nonempty string")
    }
    if (!isNonemptyString(clerkTopology.reason)) {
      errors.push("clerkApplicationTopology.reason must be a nonempty string")
    }
    for (const environment of sharedClerkEnvironments) {
      const clerk = registry.environments?.[environment]?.clerk
      if (isRecord(clerk)) {
        for (const field of clerkIdentityFields) {
          if (clerk[field] !== clerkTopology[field]) {
            errors.push(`${environment}.clerk.${field} must match clerkApplicationTopology.${field}`)
          }
        }
      }
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

  for (const field of clerkIdentityFields) {
    const configured = new Map()
    for (const environment of requiredEnvironments) {
      const value = registry.environments?.[environment]?.clerk?.[field]
      if (typeof value === "string" && value.length > 0) {
        if (configured.has(value)) {
          const environments = [configured.get(value), environment].sort()
          const allowedSharedClerkIdentity = isPinnedSharedClerkTopology(clerkTopology) &&
            value === sharedClerkIdentity[field] &&
            environments.join(",") === "development,staging"
          if (!allowedSharedClerkIdentity) {
            errors.push(`${environment}.clerk.${field} duplicates ${configured.get(value)}.clerk.${field}`)
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
