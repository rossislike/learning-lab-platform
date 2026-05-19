import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const sourceRoot =
  process.env.REACT_PRODUCT_DASHBOARD_SOURCE ??
  "/Users/stratus/dev/react/sen-cert/ch2-Rendering-Optimization/5-Optimize-Product-Dashboard";
const targetRoot = resolve(
  projectRoot,
  "lab-definitions/react-product-dashboard/workspace-template"
);

const folders = [
  "optimize-product-dashboard-1-unsolved",
  "optimize-product-dashboard-2",
];

await mkdir(targetRoot, { recursive: true });

for (const folder of folders) {
  const source = resolve(sourceRoot, folder);
  const target = resolve(targetRoot, folder);
  await rm(target, { recursive: true, force: true });
  await cp(source, target, {
    recursive: true,
    filter: (path) =>
      !path.includes("/node_modules/") &&
      !path.endsWith("/node_modules") &&
      !path.includes("/dist/") &&
      !path.endsWith("/dist") &&
      !path.endsWith(".DS_Store"),
  });
  console.log(`[import] copied ${source} -> ${target}`);
}
