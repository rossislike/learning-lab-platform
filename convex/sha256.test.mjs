import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import test from "node:test"
import { sha256Hex, timingSafeEqualHex } from "./sha256.ts"

test("sha256Hex matches Node's crypto for known vectors and random inputs", () => {
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
  for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 5000]) {
    const text = randomBytes(length).toString("base64").slice(0, length) + "é✓"
    const expected = createHash("sha256").update(text, "utf8").digest("hex")
    assert.equal(sha256Hex(text), expected, `length ${length}`)
  }
})

test("timingSafeEqualHex compares equal-length strings only", () => {
  assert.equal(timingSafeEqualHex("abc", "abc"), true)
  assert.equal(timingSafeEqualHex("abc", "abd"), false)
  assert.equal(timingSafeEqualHex("abc", "ab"), false)
})
