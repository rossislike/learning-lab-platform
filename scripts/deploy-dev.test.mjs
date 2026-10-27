import assert from "node:assert/strict";
import test from "node:test";
import { redactSecrets } from "./deploy-dev.mjs";

test("redactSecrets removes every occurrence of each secret and ignores empty ones", () => {
  const message = "npx convex env set RUNNER_SHARED_SECRET s3cr,et\\x --prod exited 1\nbad value s3cr,et\\x";
  assert.equal(redactSecrets(message, ["s3cr,et\\x", "", undefined]), "npx convex env set RUNNER_SHARED_SECRET *** --prod exited 1\nbad value ***");
  assert.equal(redactSecrets("nothing to hide", []), "nothing to hide");
});
