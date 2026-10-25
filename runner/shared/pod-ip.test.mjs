import assert from "node:assert/strict"
import test from "node:test"
import { isAllowedPodIp } from "./pod-ip.mjs"
import { isAllowedPodIp as convexIsAllowedPodIp } from "../../convex/accessPolicy.ts"

const VECTORS = [
  "10.244.1.7", "172.18.0.5", "192.168.1.1", "8.8.8.8", "fd00::1", "2001:db8::7", "::ffff:a00:1",
  "127.0.0.1", "127.1.2.3", "0.0.0.0", "169.254.169.254", "::1", "::", "fe80::1", "FE80::abcd",
  "::ffff:7f00:1", "::ffff:a9fe:a9fe", "::ffff:10.0.0.1", "10.0.0", "10.0.0.256", "localhost", "example.com",
  "10.0.0.1:7000", "", undefined, null, 42, "1:2:3:4:5:6:7:8:9", "1::2::3", "12345::1", "10.0.0.1\n",
]

test("gateway pod-ip rules agree with convex/accessPolicy.ts", () => {
  for (const value of VECTORS) assert.equal(isAllowedPodIp(value), convexIsAllowedPodIp(value), String(value))
  assert.equal(isAllowedPodIp("10.244.1.7"), true)
  assert.equal(isAllowedPodIp("127.0.0.1"), false)
  assert.equal(isAllowedPodIp("169.254.169.254"), false)
  assert.equal(isAllowedPodIp("::1"), false)
})
