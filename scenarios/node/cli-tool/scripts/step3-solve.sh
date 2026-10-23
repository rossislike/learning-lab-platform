#!/usr/bin/env bash
set -euo pipefail
: "${LAB_WORKSPACE:?}"
cat > "$LAB_WORKSPACE/greet.js" <<'JS'
const args = process.argv.slice(2);
if (args.length > 1) {
  console.error("Usage: node greet.js [name]");
  process.exit(1);
}
const name = args[0] ?? "world";
console.log(`Hello, ${name}!`);
JS
