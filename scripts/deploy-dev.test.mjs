import assert from "node:assert/strict";
import test from "node:test";
import { buildxCacheArgs, normalizeImageTag, redactSecrets } from "./deploy-dev.mjs";

test("redactSecrets removes every occurrence of each secret and ignores empty ones", () => {
  const message = "npx convex env set RUNNER_SHARED_SECRET s3cr,et\\x --prod exited 1\nbad value s3cr,et\\x";
  assert.equal(redactSecrets(message, ["s3cr,et\\x", "", undefined]), "npx convex env set RUNNER_SHARED_SECRET *** --prod exited 1\nbad value ***");
  assert.equal(redactSecrets("nothing to hide", []), "nothing to hide");
});

test("IMAGE_TAG: a full commit SHA is shortened to 12, other tags pass, invalid ones fail", () => {
  assert.equal(normalizeImageTag("0123456789abcdef0123456789abcdef01234567"), "0123456789ab");
  assert.equal(normalizeImageTag("0123456789ab"), "0123456789ab");
  assert.equal(normalizeImageTag("v1.2.3-rc_1"), "v1.2.3-rc_1");
  assert.throws(() => normalizeImageTag("bad tag"), /not a valid image tag/);
  assert.throws(() => normalizeImageTag("-x"), /not a valid image tag/);
});

test("BUILDX_CACHE: off when unset, gha caches get a per-image scope", () => {
  assert.deepEqual(buildxCacheArgs(undefined, "platform"), []);
  assert.deepEqual(buildxCacheArgs("type=gha", "platform"), ["--cache-from", "type=gha,scope=platform", "--cache-to", "type=gha,scope=platform,mode=max"]);
  assert.deepEqual(buildxCacheArgs("type=gha,scope=x", "platform"), ["--cache-from", "type=gha,scope=x", "--cache-to", "type=gha,scope=x,mode=max"]);
  assert.deepEqual(buildxCacheArgs("type=registry,ref=r/c", "platform"), ["--cache-from", "type=registry,ref=r/c", "--cache-to", "type=registry,ref=r/c,mode=max"]);
});
