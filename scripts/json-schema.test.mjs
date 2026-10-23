import assert from "node:assert/strict"
import test from "node:test"
import { formatSchemaErrors, validateAgainstSchema } from "./json-schema.mjs"

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["slug", "steps"],
  properties: {
    slug: { type: "string", pattern: "^[a-z-]+$", maxLength: 10 },
    kind: { type: "string", enum: ["terminal", "react"] },
    version: { const: 2 },
    order: { type: "integer", minimum: 0 },
    tags: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string" } },
    steps: { type: "array", items: { $ref: "#/$defs/step" } },
  },
  $defs: {
    step: { type: "object", required: ["title"], properties: { title: { type: "string", minLength: 1 } } },
  },
}

test("accepts a valid document", () => {
  assert.deepEqual(
    validateAgainstSchema(schema, { slug: "ok", kind: "react", version: 2, order: 3, tags: ["a"], steps: [{ title: "x" }] }),
    [],
  )
})

test("reports every violation with a path", () => {
  const errors = validateAgainstSchema(schema, {
    slug: "Bad Slug!",
    kind: "vm",
    version: 1,
    order: 1.5,
    tags: ["a", "a"],
    steps: [{}],
    extra: true,
  })
  const text = formatSchemaErrors(errors)
  for (const expected of [
    "$.slug must match",
    "$.kind must be one of",
    "$.version must be 2",
    "$.order must be of type integer",
    "$.tags[1] is a duplicate",
    "$.steps[0].title is required",
    "$.extra is not an allowed property",
  ]) {
    assert.match(text, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  }
})

test("missing required fields and wrong root type are reported", () => {
  assert.equal(validateAgainstSchema(schema, {}).length, 2)
  assert.equal(validateAgainstSchema(schema, "nope").length, 1)
})

test("unsupported keywords throw instead of being ignored", () => {
  assert.throws(
    () => validateAgainstSchema({ type: "object", properties: { n: { anyOf: [{ type: "string" }] } } }, { n: 1 }),
    /Unsupported JSON Schema keyword "anyOf" at \$\.n/,
  )
  assert.throws(
    () => validateAgainstSchema({ type: "integer", exclusiveMinimum: 0 }, 1),
    /Unsupported JSON Schema keyword "exclusiveMinimum"/,
  )
  assert.throws(
    () => validateAgainstSchema({ $defs: { x: { oneOf: [] } }, type: "array", items: { $ref: "#/$defs/x" } }, [1]),
    /Unsupported JSON Schema keyword "oneOf" at #\/\$defs\/x/,
  )
})

test("$ref resolves into $defs and local keywords override the target", () => {
  const refSchema = {
    $defs: { name: { type: "string", minLength: 3 } },
    type: "object",
    properties: { a: { $ref: "#/$defs/name" }, b: { $ref: "#/$defs/name", minLength: 1 } },
  }
  assert.deepEqual(validateAgainstSchema(refSchema, { a: "abc", b: "x" }), [])
  assert.equal(validateAgainstSchema(refSchema, { a: "ab", b: "" }).length, 2)
  assert.throws(() => validateAgainstSchema({ $ref: "#/$defs/missing" }, {}), /Unresolvable \$ref/)
  assert.throws(() => validateAgainstSchema({ $ref: "http://x/y" }, {}), /Unsupported \$ref/)
})

test("uniqueItems compares structurally and reports the duplicate index", () => {
  const arraySchema = { type: "array", uniqueItems: true }
  assert.deepEqual(validateAgainstSchema(arraySchema, [{ a: 1 }, { a: 2 }]), [])
  assert.deepEqual(validateAgainstSchema(arraySchema, [{ a: 1 }, { a: 1 }]), [{ path: "$[1]", message: "is a duplicate" }])
})

test("additionalProperties as a schema validates unknown keys", () => {
  const mapSchema = {
    type: "object",
    properties: { known: { type: "boolean" } },
    additionalProperties: { type: "integer", minimum: 1 },
  }
  assert.deepEqual(validateAgainstSchema(mapSchema, { known: true, x: 2 }), [])
  assert.equal(validateAgainstSchema(mapSchema, { x: 0, y: "no" }).length, 2)
  // additionalProperties omitted: unknown keys pass through untouched
  assert.deepEqual(validateAgainstSchema({ type: "object", properties: {} }, { anything: null }), [])
})

test("prototype keys are not treated as present or as declared properties", () => {
  const protoSchema = {
    type: "object",
    additionalProperties: false,
    required: ["constructor"],
    properties: { constructor: { type: "integer" }, toString: { type: "string" } },
  }
  const text = formatSchemaErrors(validateAgainstSchema(protoSchema, { hasOwnProperty: "x" }))
  assert.match(text, /\$\.constructor is required/)
  assert.match(text, /\$\.hasOwnProperty is not an allowed property/)
  assert.deepEqual(validateAgainstSchema(protoSchema, { constructor: 1, toString: "ok" }), [])
})
