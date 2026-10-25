// Static contract check between the platform services and Convex: every
// `convex.mutation("ns:fn", …)` / `convex.query("ns:fn", …)` string literal in
// the dispatcher and gateway must name an exported Convex function whose
// validator accepts `runnerSecret` — convex-http.mjs adds the secret to every
// call, and a function without the argument rejects the call (ArgumentValidationError),
// which is exactly how the heartbeat regressed once.

import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { resolve } from "node:path"
import test from "node:test"

const root = new URL("../../", import.meta.url).pathname
const SERVICE_DIRS = ["runner/dispatcher", "runner/gateway"]
const CALL = /\.(mutation|query)\(\s*"([a-zA-Z0-9_]+):([a-zA-Z0-9_]+)"/g

async function serviceCalls() {
  const calls = new Map() // "ns:fn" → { kind, files }
  for (const dir of SERVICE_DIRS) {
    for (const file of await readdir(resolve(root, dir))) {
      if (!file.endsWith(".mjs") || file.endsWith(".test.mjs")) continue
      const source = await readFile(resolve(root, dir, file), "utf8")
      for (const match of source.matchAll(CALL)) {
        const [, kind, ns, fn] = match
        const key = `${ns}:${fn}`
        const entry = calls.get(key) ?? { kind, files: new Set() }
        assert.equal(entry.kind, kind, `${key} is called as both ${entry.kind} and ${kind}`)
        entry.files.add(`${dir}/${file}`)
        calls.set(key, entry)
      }
    }
  }
  return calls
}

/** The `args: { … }` block of `export const <fn> = (mutation|query)({` in a Convex module, or null. */
function exportedFunction(source, fn) {
  const header = new RegExp(`export const ${fn} = (mutation|query)\\(\\{`)
  const match = header.exec(source)
  if (!match) return null
  const start = match.index + match[0].length
  const argsAt = source.indexOf("args:", start)
  assert.ok(argsAt !== -1 && argsAt - start < 200, `${fn}: args block not found right after the header`)
  const open = source.indexOf("{", argsAt)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1
    if (source[i] === "}") depth -= 1
    if (depth === 0) return { kind: match[1], args: source.slice(open, i + 1) }
  }
  throw new Error(`${fn}: unterminated args block`)
}

test("every Convex function the dispatcher and gateway call exists, has the right kind, and takes runnerSecret", async () => {
  const calls = await serviceCalls()
  assert.ok(calls.size >= 10, `expected to find service calls, got ${calls.size}`)
  const sources = new Map()
  for (const [key, { kind, files }] of calls) {
    const [ns, fn] = key.split(":")
    if (!sources.has(ns)) sources.set(ns, await readFile(resolve(root, "convex", `${ns}.ts`), "utf8"))
    const found = exportedFunction(sources.get(ns), fn)
    const where = [...files].join(", ")
    assert.ok(found, `${key} (called from ${where}) is not exported by convex/${ns}.ts`)
    assert.equal(found.kind, kind, `${key} is a ${found.kind} but ${where} calls it as a ${kind}`)
    assert.match(found.args, /\brunnerSecret:\s*v\.string\(\)/, `${key} (called from ${where}) must declare runnerSecret: v.string() in args`)
  }
})

test("the contract scanner sees the calls it is meant to see", async () => {
  const calls = await serviceCalls()
  for (const expected of ["runners:heartbeat", "runners:acquireLease", "sessions:listForDispatcher", "workspaceAccess:checkGrant", "workspaceAccess:consumeBootstrap"]) {
    assert.ok(calls.has(expected), `${expected} should be found by the scanner`)
  }
})
