import { build } from "esbuild"
import { readFile, writeFile } from "node:fs/promises"

const outputPath = new URL("index.cjs", import.meta.url).pathname

await build({
  bundle: true,
  entryPoints: [new URL("ttl-cleanup.mjs", import.meta.url).pathname],
  format: "cjs",
  minify: true,
  outfile: outputPath,
  platform: "node",
  target: "node22",
})

const bundle = await readFile(outputPath, "utf8")
await writeFile(outputPath, bundle.replace(/[ \t]+$/gm, ""))
