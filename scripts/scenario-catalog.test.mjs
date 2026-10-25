import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import test from "node:test"
import { CatalogError, loadCatalog, loadScenario, toSeedRecord } from "./scenario-catalog.mjs"

test("the checked-in catalog validates and every area has a playground", async () => {
  const { areas, scenarios } = await loadCatalog()
  assert.ok(areas.length >= 4)
  for (const area of areas) {
    const inArea = scenarios.filter((scenario) => scenario.manifest.area === area.slug)
    assert.ok(inArea.length >= 1, `${area.slug} has scenarios`)
    assert.ok(
      inArea.some((scenario) => scenario.steps.length === 0),
      `${area.slug} has a playground`,
    )
  }
  const slugs = scenarios.map((scenario) => scenario.manifest.slug)
  assert.equal(new Set(slugs).size, slugs.length)
  for (const scenario of scenarios) {
    for (const step of scenario.steps) {
      if (step.verify) assert.ok(step.solve, `${scenario.manifest.slug}: verifiable steps carry a solve script`)
    }
    if (scenario.manifest.kind === "react") {
      assert.deepEqual(scenario.tabs, ["terminal", "editor", "preview"])
    } else {
      assert.deepEqual(scenario.tabs, ["terminal"])
    }
  }
})

test("seed records inline markdown, drop solve scripts, and keep legacy runner fields for react", async () => {
  const { areas, scenarios } = await loadCatalog()
  const areasBySlug = new Map(areas.map((area) => [area.slug, area]))
  const git = scenarios.find((scenario) => scenario.manifest.slug === "first-commit")
  const record = toSeedRecord(git, areasBySlug)
  assert.equal(record.kind, "terminal")
  assert.equal(record.sourceDir, "git/first-commit")
  assert.equal(record.difficulty, 1)
  assert.match(record.intro, /git init|Git/)
  assert.equal(record.steps.length, 3)
  assert.ok(record.steps.every((step) => !("solve" in step)))
  assert.ok(record.steps.every((step) => step.content.length > 20))
  assert.equal(record.templatePath, undefined)

  const react = scenarios.find((scenario) => scenario.manifest.slug === "welcome-message")
  const reactRecord = toSeedRecord(react, areasBySlug)
  assert.equal(reactRecord.templatePath, "scenarios/react/welcome-message/workspace")
  assert.equal(reactRecord.validationCommand, "npm test -- --run --reporter=json")
  assert.equal(reactRecord.react.previewPort, 5173)
})

async function withScenario(files, run) {
  const dir = await mkdtemp(resolve(tmpdir(), "llp-catalog-"))
  try {
    for (const [name, contents] of Object.entries(files)) {
      await mkdir(resolve(dir, name, ".."), { recursive: true })
      await writeFile(resolve(dir, name), contents)
    }
    await run(resolve(dir, "manifest.json"))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const baseManifest = {
  schemaVersion: 2,
  slug: "demo",
  area: "linux",
  kind: "terminal",
  title: "Demo",
  summary: "Demo scenario",
  difficulty: "easy",
  tags: ["demo"],
  status: "active",
  displayOrder: 1,
  ttlSeconds: 600,
  workspace: { cwd: "/workspace", user: "learner" },
  intro: "intro.md",
  finish: "finish.md",
  steps: [{ title: "One", content: "step1.md", verify: "scripts/step1-verify.sh" }],
}

test("loadScenario rejects schema violations, missing files, and kind mismatches", async () => {
  await withScenario(
    {
      "manifest.json": JSON.stringify({ ...baseManifest, kind: "vm" }),
      "intro.md": "hi",
      "finish.md": "bye",
      "step1.md": "do it",
      "scripts/step1-verify.sh": "exit 0",
    },
    (manifestPath) => assert.rejects(loadScenario(manifestPath), CatalogError),
  )
  await withScenario(
    {
      "manifest.json": JSON.stringify(baseManifest),
      "intro.md": "hi",
      "finish.md": "bye",
      "step1.md": "do it",
    },
    (manifestPath) => assert.rejects(loadScenario(manifestPath), /missing steps\[0\]\.verify/),
  )
  await withScenario(
    {
      "manifest.json": JSON.stringify({ ...baseManifest, react: { previewPort: 5173, installCommand: "a", devCommand: "b", testCommand: "c" } }),
      "intro.md": "hi",
      "finish.md": "bye",
      "step1.md": "do it",
      "scripts/step1-verify.sh": "exit 0",
    },
    (manifestPath) => assert.rejects(loadScenario(manifestPath), /must not define the react block/),
  )
  await withScenario(
    {
      "manifest.json": JSON.stringify({ ...baseManifest, kind: "react", react: { previewPort: 5173, installCommand: "a", devCommand: "b", testCommand: "c" } }),
      "intro.md": "hi",
      "finish.md": "bye",
      "step1.md": "do it",
      "scripts/step1-verify.sh": "exit 0",
    },
    (manifestPath) => assert.rejects(loadScenario(manifestPath), /no workspace\/ directory/),
  )
  await withScenario(
    {
      "manifest.json": JSON.stringify(baseManifest),
      "intro.md": "hi",
      "finish.md": "bye",
      "step1.md": "do it",
      "scripts/step1-verify.sh": "exit 0",
    },
    (manifestPath) => assert.rejects(loadScenario(manifestPath, { areaSlug: "git" }), /lives under scenarios\/git/),
  )
  await withScenario(
    {
      "manifest.json": JSON.stringify(baseManifest),
      "intro.md": "hi",
      "finish.md": "bye",
      "step1.md": "do it",
      "scripts/step1-verify.sh": "exit 0",
    },
    async (manifestPath) => {
      const scenario = await loadScenario(manifestPath, { areaSlug: "linux" })
      assert.equal(scenario.steps[0].verify, "scripts/step1-verify.sh")
      assert.equal(scenario.difficultyLevel, 1)
    },
  )
})

async function withCatalog(files, run) {
  const root = await mkdtemp(resolve(tmpdir(), "llp-catalog-root-"))
  try {
    for (const [name, contents] of Object.entries(files)) {
      await mkdir(resolve(root, name, ".."), { recursive: true })
      await writeFile(resolve(root, name), typeof contents === "string" ? contents : JSON.stringify(contents))
    }
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const linuxArea = { slug: "linux", title: "Linux", summary: "Shell basics", displayOrder: 1 }
const terminalScenario = (overrides) => ({
  ...baseManifest,
  steps: [],
  ...overrides,
})
const scenarioFiles = (dir, manifest) => ({
  [`${dir}/manifest.json`]: manifest,
  [`${dir}/intro.md`]: "hi",
  [`${dir}/finish.md`]: "bye",
})

test("loadCatalog enforces the playground rule in both directions and displayOrder 0", async () => {
  // happy path: playground/ + <area>-playground + displayOrder 0, and a normal scenario
  await withCatalog(
    {
      "linux/area.json": linuxArea,
      ...scenarioFiles("linux/playground", terminalScenario({ slug: "linux-playground", displayOrder: 0 })),
      ...scenarioFiles("linux/demo", terminalScenario({ slug: "demo", displayOrder: 5 })),
    },
    async (root) => {
      const { areas, scenarios } = await loadCatalog(root)
      assert.deepEqual(areas.map((area) => area.slug), ["linux"])
      assert.deepEqual(scenarios.map((scenario) => scenario.manifest.slug), ["linux-playground", "demo"])
    },
  )
  // playground/ directory with the wrong slug
  await withCatalog(
    {
      "linux/area.json": linuxArea,
      ...scenarioFiles("linux/playground", terminalScenario({ slug: "sandbox", displayOrder: 0 })),
    },
    (root) => assert.rejects(loadCatalog(root), /lives in playground\/ so its slug must be "linux-playground"/),
  )
  // playground slug outside playground/ (including another area's playground slug)
  await withCatalog(
    {
      "linux/area.json": linuxArea,
      ...scenarioFiles("linux/linux-playground", terminalScenario({ slug: "linux-playground", displayOrder: 0 })),
    },
    (root) => assert.rejects(loadCatalog(root), /must live in scenarios\/linux\/playground\//),
  )
  await withCatalog(
    {
      "linux/area.json": linuxArea,
      ...scenarioFiles("linux/git-playground", terminalScenario({ slug: "git-playground", displayOrder: 0 })),
    },
    (root) => assert.rejects(loadCatalog(root), /displayOrder 0 is reserved/),
  )
  // playground must use displayOrder 0 and have no steps
  await withCatalog(
    {
      "linux/area.json": linuxArea,
      ...scenarioFiles("linux/playground", terminalScenario({ slug: "linux-playground", displayOrder: 3 })),
    },
    (root) => assert.rejects(loadCatalog(root), /must use displayOrder 0/),
  )
  await withCatalog(
    {
      "linux/area.json": linuxArea,
      ...scenarioFiles("linux/playground", terminalScenario({ slug: "linux-playground", displayOrder: 0, steps: [{ title: "One", content: "step1.md" }] })),
      "linux/playground/step1.md": "do it",
    },
    (root) => assert.rejects(loadCatalog(root), /must not define steps/),
  )
  // ordinary scenario: directory must equal slug, displayOrder 0 forbidden
  await withCatalog(
    {
      "linux/area.json": linuxArea,
      ...scenarioFiles("linux/other", terminalScenario({ slug: "demo", displayOrder: 5 })),
    },
    (root) => assert.rejects(loadCatalog(root), /slug "demo" must match its directory name/),
  )
  await withCatalog(
    {
      "linux/area.json": linuxArea,
      ...scenarioFiles("linux/demo", terminalScenario({ slug: "demo", displayOrder: 0 })),
    },
    (root) => assert.rejects(loadCatalog(root), /displayOrder 0 is reserved/),
  )
})

test("loadCatalog rejects missing area.json, mismatched area slugs, and duplicate slugs", async () => {
  await withCatalog(
    { ...scenarioFiles("linux/demo", terminalScenario({ slug: "demo" })) },
    (root) => assert.rejects(loadCatalog(root), /scenarios\/linux\/ has no area\.json/),
  )
  await withCatalog(
    { "linux/area.json": { ...linuxArea, slug: "shell" } },
    (root) => assert.rejects(loadCatalog(root), /slug "shell" must match its directory name/),
  )
  await withCatalog(
    { "linux/area.json": linuxArea, "linux/demo/.keep": "" },
    (root) => assert.rejects(loadCatalog(root), /has no manifest\.json/),
  )
  await withCatalog(
    {
      "linux/area.json": linuxArea,
      "git/area.json": { slug: "git", title: "Git", summary: "Version control", displayOrder: 2 },
      ...scenarioFiles("linux/demo", terminalScenario({ slug: "demo" })),
      ...scenarioFiles("git/demo", terminalScenario({ slug: "demo", area: "git" })),
    },
    (root) => assert.rejects(loadCatalog(root), /duplicate scenario slug "demo"/),
  )
})

test("seed records use --passWithNoTests only for scenarios without a verify step", async () => {
  const { areas, scenarios } = await loadCatalog()
  const areasBySlug = new Map(areas.map((area) => [area.slug, area]))
  const playground = scenarios.find((scenario) => scenario.manifest.slug === "react-playground")
  assert.equal(
    toSeedRecord(playground, areasBySlug).validationCommand,
    "npm test -- --run --passWithNoTests --reporter=json",
  )
  const dashboard = scenarios.find((scenario) => scenario.manifest.slug === "product-dashboard")
  assert.equal(toSeedRecord(dashboard, areasBySlug).validationCommand, "npm test -- --run --reporter=json")
})
