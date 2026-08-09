import assert from "node:assert/strict"
import test from "node:test"
import { handleSessionGatewayRequest } from "./session-gateway.mjs"

function request(method, url) {
  const result = { body: "", headers: {}, statusCode: 0 }
  handleSessionGatewayRequest({ method, url }, {
    end(body) {
      result.body = body
    },
    writeHead(statusCode, headers) {
      result.statusCode = statusCode
      result.headers = headers
    },
  })
  return result
}

test("gateway health endpoint reports process health", () => {
  const response = request("GET", "/health")

  assert.equal(response.statusCode, 200)
  assert.deepEqual(JSON.parse(response.body), { status: "healthy" })
  assert.equal(response.headers["cache-control"], "no-store")
})

test("gateway fails closed until authenticated routing is implemented", () => {
  const response = request("GET", "/workspace")

  assert.equal(response.statusCode, 503)
  assert.deepEqual(JSON.parse(response.body), {
    code: "gateway-deployment-pending",
    message: "Authenticated session routing is not enabled.",
  })
  assert.equal(response.headers["x-content-type-options"], "nosniff")
})
