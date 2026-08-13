import assert from "node:assert/strict"
import { statSync } from "node:fs"
import test from "node:test"

import { runScenarioPublisher } from "./publish-scenario-artifacts.mjs"

const account = "111111111111"
const registry = {
  schemaVersion: 1,
  environments: {
    development: {
      awsAccountId: null,
      clerkApplicationId: "app_development",
      convexDeployment: null,
    },
    staging: {
      awsAccountId: account,
      clerkApplicationId: "app_staging",
      convexDeployment: "prod:staging-labs",
    },
    production: {
      awsAccountId: "222222222222",
      clerkApplicationId: "app_production",
      convexDeployment: "prod:production-labs",
    },
  },
  temporaryException: {
    allowedIdentitySharing: [],
    approved: false,
    approver: null,
    deadline: "2026-08-12",
    migrationStatus: "blocked",
    owner: "test",
    productionLearnerTrafficBlocked: true,
    reason: "No exception is needed for distinct test identities.",
  },
}

function publisherExecutor({ corruptHead = false } = {}) {
  const calls = []
  const objects = new Map()
  return {
    calls,
    execute(command, args) {
      calls.push([command, args])
      if (command === "terraform") {
        return { status: 0, stdout: "artifact-bucket\n", stderr: "" }
      }
      if (command === "npx") return { status: 0, stdout: "null\n", stderr: "" }
      if (args[0] === "sts") return { status: 0, stdout: `${account}\n`, stderr: "" }
      if (args[1] === "put-object") {
        const key = args[args.indexOf("--key") + 1]
        const checksum = args[args.indexOf("--checksum-sha256") + 1]
        const metadata = args[args.indexOf("--metadata") + 1]
        const body = args[args.indexOf("--body") + 1]
        const size = statSync(body).size
        if (!objects.has(key)) objects.set(key, { checksum, metadata, size })
        return { status: 0, stdout: "{}", stderr: "" }
      }
      if (args[1] === "head-object") {
        const key = args[args.indexOf("--key") + 1]
        const object = objects.get(key)
        const sha256 = object?.metadata.match(/sha256=([0-9a-f]{64})/)?.[1]
        return {
          status: object ? 0 : 1,
          stdout: object
            ? JSON.stringify({
                ChecksumSHA256: corruptHead ? "wrong" : object.checksum,
                ContentLength: object.size,
                Metadata: { immutable: "true", sha256 },
              })
            : "",
          stderr: object ? "" : "missing",
        }
      }
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`)
    },
  }
}

test("publisher uploads digest-addressed objects before approving Convex", async () => {
  const fake = publisherExecutor()
  const status = await runScenarioPublisher(
    ["staging", "--slug=react-welcome-message"],
    { execute: fake.execute, loadRegistry: async () => registry },
  )

  assert.equal(status, 0)
  const putCalls = fake.calls.filter(([, args]) => args[1] === "put-object")
  assert.equal(putCalls.length, 2)
  for (const [, args] of putCalls) {
    assert.deepEqual(args.slice(-2), ["--if-none-match", "*"])
    assert.equal(
      args[args.indexOf("--expected-bucket-owner") + 1],
      account,
    )
    assert.match(args[args.indexOf("--key") + 1], /\/sha256\/[0-9a-f]{64}\.(tar|json)$/)
  }
  const headCalls = fake.calls.filter(([, args]) => args[1] === "head-object")
  assert.equal(headCalls.length, 2)
  for (const [, args] of headCalls) {
    assert.equal(
      args[args.indexOf("--expected-bucket-owner") + 1],
      account,
    )
  }
  const convexCall = fake.calls.find(([command]) => command === "npx")
  assert.ok(convexCall)
  assert.equal(convexCall[1][2], "internal.scenarioArtifacts.approve")
  const approval = JSON.parse(convexCall[1][3])
  assert.match(approval.artifactKey, new RegExp(approval.artifactSha256))
  assert.match(approval.manifestKey, new RegExp(approval.manifestSha256))
  assert.equal(approval.schemaVersion, 1)
  assert.equal(
    approval.runtime.packagedWorkspaceTemplatePath,
    "lab-definitions/react-welcome-message/workspace-template/update-welcome-message-1",
  )
  assert.equal(
    approval.runtime.validationCommand,
    "npm test -- --run --reporter=json",
  )
  assert.ok(fake.calls.indexOf(convexCall) > fake.calls.findLastIndex(([, args]) => args[1] === "head-object"))
})

test("publisher does not approve an object that fails checksum verification", async () => {
  const fake = publisherExecutor({ corruptHead: true })
  await assert.rejects(
    runScenarioPublisher(["staging", "--slug=react-welcome-message"], {
      execute: fake.execute,
      loadRegistry: async () => registry,
    }),
    /was not verified/,
  )
  assert.equal(fake.calls.some(([command]) => command === "npx"), false)
})

test("publisher dry-run is local and does not require environment identities", async () => {
  const status = await runScenarioPublisher(
    ["staging", "--slug=react-welcome-message", "--dry-run"],
    {
      execute: () => {
        throw new Error("dry-run must not execute external commands")
      },
      loadRegistry: async () => {
        throw new Error("dry-run must not load environment configuration")
      },
    },
  )
  assert.equal(status, 0)
})
