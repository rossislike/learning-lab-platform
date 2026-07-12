import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

const defaultRegistryUrl = new URL("../config/hosted-environments.json", import.meta.url)
const requiredEnvironments = ["development", "staging", "production"]
const identityFields = ["awsAccountId", "clerkApplicationId", "convexDeployment"]
const migrationStatuses = new Set(["blocked", "planned", "in-progress", "complete"])

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

function isRealDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

export function validateIsolationRegistry(registry, { today = new Date() } = {}) {
  const errors = []
  const blockers = []

  if (!isRecord(registry)) return { blockers, errors: ["registry must be an object"], ready: false }
  if (registry.schemaVersion !== 1) errors.push("schemaVersion must be 1")
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

  for (const field of identityFields) {
    const configured = new Map()
    for (const environment of requiredEnvironments) {
      const value = registry.environments?.[environment]?.[field]
      if (value === null && environment !== "development") blockers.push(`${environment}.${field} is not configured`)
      if (typeof value === "string" && value.length > 0) {
        if (configured.has(value)) errors.push(`${environment}.${field} duplicates ${configured.get(value)}.${field}`)
        else configured.set(value, environment)
      }
    }
  }

  const exception = registry.temporaryException
  if (!isRecord(exception)) {
    errors.push("temporaryException must be an object")
  } else {
    if (typeof exception.approved !== "boolean") errors.push("temporaryException.approved must be boolean")
    if (exception.blocksProduction !== true) errors.push("temporaryException.blocksProduction must be true")
    if (!isNonemptyString(exception.owner)) errors.push("temporaryException.owner must be a nonempty string")
    if (!isNonemptyString(exception.reason)) errors.push("temporaryException.reason must be a nonempty string")
    if (!migrationStatuses.has(exception.migrationStatus)) {
      errors.push("temporaryException.migrationStatus must be blocked, planned, in-progress, or complete")
    }
    if (exception.approved === true && !isNonemptyString(exception.approver)) {
      errors.push("temporaryException.approver must be a nonempty string when approved")
    } else if (exception.approved === false && exception.approver !== null) {
      errors.push("temporaryException.approver must be null when unapproved")
    }
    if (!isRealDate(exception.deadline)) {
      errors.push("temporaryException.deadline must be a real YYYY-MM-DD date")
    } else {
      const deadline = new Date(`${exception.deadline}T23:59:59.999Z`)
      if (blockers.length > 0 && today.getTime() > deadline.getTime()) {
        errors.push("temporary environment-isolation exception has expired")
      }
    }
  }

  return { blockers, errors, ready: errors.length === 0 && blockers.length === 0 }
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
  console.log(result.ready ? "Hosted environment identities are isolated." : "Environment registry is valid but not hosted-ready.")
  return 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await runCli()
