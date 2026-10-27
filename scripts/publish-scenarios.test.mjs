import assert from "node:assert/strict";
import test from "node:test";
import { assertScenarioArtifactApproval } from "../convex/scenarioArtifactPolicy.ts";
import { describeArtifact, runtimeContractFor } from "./publish-scenarios.mjs";
import { listTarEntries } from "./scenario-bundle.mjs";
import { loadCatalog } from "./scenario-catalog.mjs";

test("every active scenario produces an approval Convex accepts, and bundles exclude solutions", async () => {
  const { scenarios } = await loadCatalog();
  const active = scenarios.filter((scenario) => scenario.manifest.status === "active");
  assert.ok(active.length > 0);
  for (const scenario of active) {
    const artifact = await describeArtifact(scenario);
    assert.doesNotThrow(() => assertScenarioArtifactApproval(artifact.approval), artifact.slug);
    assert.equal(artifact.approval.artifactKey, `scenarios/${artifact.slug}/bundles/sha256/${artifact.bundle.sha256}.tar`);
    assert.equal(artifact.approval.runtime.stepCount, scenario.steps.length);
    const entries = listTarEntries(artifact.bundle.tar);
    assert.ok(entries.includes("manifest.json"), `${artifact.slug} bundle has manifest.json`);
    assert.ok(!entries.some((path) => path.startsWith("solution/")), `${artifact.slug} bundle has no solution/`);
    const solves = (scenario.manifest.steps ?? []).map((step) => step.solve).filter(Boolean);
    for (const solve of solves) assert.ok(!entries.includes(solve), `${artifact.slug} bundle has no ${solve}`);
    assert.ok(!JSON.parse(artifact.manifestJson).steps?.some((step) => step.solve), `${artifact.slug} bundled manifest has no solve`);
  }
});

test("runtime contract mirrors the manifest and omits react for terminal scenarios", () => {
  const terminal = runtimeContractFor({ manifest: { kind: "terminal", ttlSeconds: 1800, workspace: { cwd: "/workspace", user: "learner" }, setup: "scripts/setup.sh" }, tabs: ["terminal"], steps: [{}, {}] });
  assert.deepEqual(terminal, { kind: "terminal", ttlSeconds: 1800, workspace: { cwd: "/workspace", user: "learner" }, tabs: ["terminal"], setup: "scripts/setup.sh", stepCount: 2 });
  const react = runtimeContractFor({ manifest: { kind: "react", ttlSeconds: 1800, workspace: { cwd: "/workspace", user: "learner" }, react: { previewPort: 5173, installCommand: "npm ci", devCommand: "npm run dev", testCommand: "npm test" } }, tabs: ["editor", "preview", "terminal"], steps: [] });
  assert.equal(react.react.previewPort, 5173);
  assert.equal(react.setup, undefined);
});
