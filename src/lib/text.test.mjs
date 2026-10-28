import assert from "node:assert/strict";
import test from "node:test";
import { stripAnsi } from "./text.ts";

test("stripAnsi removes SGR and cursor sequences, keeps text", () => {
  assert.equal(stripAnsi("\x1b[36m<p\x1b[39m \x1b[1mbold\x1b[22m plain"), "<p bold plain");
  assert.equal(stripAnsi("\x1b[2K\x1b[1G Tests  1 failed"), " Tests  1 failed");
  assert.equal(stripAnsi("no codes"), "no codes");
});

