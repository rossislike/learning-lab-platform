// Minimal JSON Schema (draft 2020-12 subset) validator used for scenario
// manifests and area definitions. Supports the keywords those schemas use:
// type, const, enum, pattern, minLength, maxLength, minimum, maximum,
// minItems, maxItems, uniqueItems, items, properties, required,
// additionalProperties, and $ref to "#/$defs/...".
//
// Any other keyword throws: a schema that uses `anyOf`, `exclusiveMinimum`,
// etc. would otherwise be silently accepted as valid for every document.
//
// Returns a list of { path, message } errors; an empty list means valid.

const SUPPORTED_KEYWORDS = new Set([
  "$schema",
  "$id",
  "title",
  "description",
  "$defs",
  "$ref",
  "type",
  "const",
  "enum",
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "uniqueItems",
  "items",
  "properties",
  "required",
  "additionalProperties",
]);

function assertSupportedKeywords(node, path) {
  for (const keyword of Object.keys(node)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) {
      throw new Error(`Unsupported JSON Schema keyword "${keyword}" at ${path}`);
    }
  }
}

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function matchesType(value, type) {
  switch (type) {
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "null":
      return value === null;
    default:
      return typeOf(value) === type;
  }
}

function resolveRef(ref, root) {
  if (!ref.startsWith("#/")) throw new Error(`Unsupported $ref: ${ref}`);
  let node = root;
  for (const part of ref.slice(2).split("/")) {
    node = node?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
    if (node === undefined) throw new Error(`Unresolvable $ref: ${ref}`);
  }
  return node;
}

export function validateAgainstSchema(schema, value, options = {}) {
  const root = options.root ?? schema;
  const errors = [];
  walk(schema, value, options.path ?? "$");
  return errors;

  function push(path, message) {
    errors.push({ path, message });
  }

  function walk(node, current, path) {
    if (node === true) return;
    if (node === false) return push(path, "is not allowed");
    assertSupportedKeywords(node, path);
    if (node.$ref) {
      const target = resolveRef(node.$ref, root);
      assertSupportedKeywords(target, node.$ref);
      node = { ...target, ...omitRef(node) };
    }

    if (node.type !== undefined) {
      const types = Array.isArray(node.type) ? node.type : [node.type];
      if (!types.some((type) => matchesType(current, type))) {
        return push(path, `must be of type ${types.join(" | ")} (got ${typeOf(current)})`);
      }
    }
    if (node.const !== undefined && JSON.stringify(current) !== JSON.stringify(node.const)) {
      push(path, `must be ${JSON.stringify(node.const)}`);
    }
    if (node.enum !== undefined && !node.enum.some((item) => JSON.stringify(item) === JSON.stringify(current))) {
      push(path, `must be one of ${node.enum.map((item) => JSON.stringify(item)).join(", ")}`);
    }

    if (typeof current === "string") {
      if (node.minLength !== undefined && current.length < node.minLength) {
        push(path, `must be at least ${node.minLength} characters`);
      }
      if (node.maxLength !== undefined && current.length > node.maxLength) {
        push(path, `must be at most ${node.maxLength} characters`);
      }
      if (node.pattern !== undefined && !new RegExp(node.pattern, "u").test(current)) {
        push(path, `must match ${node.pattern}`);
      }
    }

    if (typeof current === "number") {
      if (node.minimum !== undefined && current < node.minimum) {
        push(path, `must be >= ${node.minimum}`);
      }
      if (node.maximum !== undefined && current > node.maximum) {
        push(path, `must be <= ${node.maximum}`);
      }
    }

    if (Array.isArray(current)) {
      if (node.minItems !== undefined && current.length < node.minItems) {
        push(path, `must have at least ${node.minItems} items`);
      }
      if (node.maxItems !== undefined && current.length > node.maxItems) {
        push(path, `must have at most ${node.maxItems} items`);
      }
      if (node.uniqueItems) {
        const seen = new Set();
        current.forEach((item, index) => {
          const key = JSON.stringify(item);
          if (seen.has(key)) push(`${path}[${index}]`, "is a duplicate");
          seen.add(key);
        });
      }
      if (node.items !== undefined) {
        current.forEach((item, index) => walk(node.items, item, `${path}[${index}]`));
      }
    }

    if (current !== null && typeof current === "object" && !Array.isArray(current)) {
      const properties = node.properties ?? {};
      for (const key of node.required ?? []) {
        if (!Object.hasOwn(current, key)) push(`${path}.${key}`, "is required");
      }
      for (const [key, child] of Object.entries(current)) {
        if (Object.hasOwn(properties, key)) {
          walk(properties[key], child, `${path}.${key}`);
        } else if (node.additionalProperties === false) {
          push(`${path}.${key}`, "is not an allowed property");
        } else if (node.additionalProperties && typeof node.additionalProperties === "object") {
          walk(node.additionalProperties, child, `${path}.${key}`);
        }
      }
    }
  }
}

function omitRef(node) {
  const rest = { ...node };
  delete rest.$ref;
  return rest;
}

export function formatSchemaErrors(errors) {
  return errors.map((error) => `${error.path} ${error.message}`).join("\n");
}
