import assert from "node:assert/strict"
import test from "node:test"
import { learnerProcessEnv } from "./learner-process-env.mjs"

test("learner process environment removes runner and cloud credentials", () => {
  const environment = learnerProcessEnv({
    PATH: "/usr/bin",
    RUNNER_SHARED_SECRET: "runner-secret",
    AWS_ACCESS_KEY_ID: "access-key",
    AWS_SECRET_ACCESS_KEY: "secret-key",
    AWS_SESSION_TOKEN: "session-token",
    AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/credentials",
    ECS_CONTAINER_METADATA_URI_V4: "http://metadata",
  })

  assert.deepEqual(environment, { PATH: "/usr/bin" })
})

test("trusted callers must explicitly add callback credentials", () => {
  const environment = learnerProcessEnv(
    { RUNNER_SHARED_SECRET: "inherited", PATH: "/usr/bin" },
    { RUNNER_SHARED_SECRET: "explicit" },
  )

  assert.equal(environment.RUNNER_SHARED_SECRET, "explicit")
})
