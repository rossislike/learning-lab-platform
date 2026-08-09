import { cp, mkdir, readFile, readdir } from "node:fs/promises"
import { dirname, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"

function safeChildPath(root, child, label) {
  const target = resolve(root, child)
  const rel = relative(root, target)
  if (!rel || rel.startsWith("..") || rel.includes("node_modules")) {
    throw new Error(`${label} must point to a child of ${root}`)
  }
  return { target, rel }
}

export async function packageLearnerTemplates(sourceRoot, destinationRoot) {
  const labs = await readdir(sourceRoot, { withFileTypes: true })
  let packaged = 0

  for (const lab of labs) {
    if (!lab.isDirectory()) continue

    const manifestPath = resolve(sourceRoot, lab.name, "manifest.json")
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
    if (typeof manifest.workspaceTemplate !== "string") {
      throw new Error(`${manifestPath} must define workspaceTemplate`)
    }

    const labRoot = resolve(sourceRoot, lab.name)
    const source = safeChildPath(
      labRoot,
      manifest.workspaceTemplate,
      `${manifestPath} workspaceTemplate`,
    )
    const destination = resolve(destinationRoot, lab.name, source.rel)
    await mkdir(dirname(destination), { recursive: true })
    await cp(source.target, destination, {
      recursive: true,
      filter: (path) =>
        !path.includes("/node_modules/") &&
        !path.endsWith("/node_modules") &&
        !path.includes("/dist/") &&
        !path.endsWith("/dist"),
    })
    packaged += 1
  }

  if (packaged === 0) throw new Error("No learner templates were packaged")
  return packaged
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const sourceRoot = resolve(process.argv[2] ?? "lab-definitions")
  const destinationRoot = resolve(process.argv[3] ?? "learner-lab-definitions")
  const count = await packageLearnerTemplates(sourceRoot, destinationRoot)
  console.log(`[learner-templates] packaged ${count} starter templates`)
}
