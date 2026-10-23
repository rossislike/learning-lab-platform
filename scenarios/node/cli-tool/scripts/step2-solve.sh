#!/usr/bin/env bash
set -euo pipefail
: "${LAB_WORKSPACE:?}"
cat > "$LAB_WORKSPACE/greet.js" <<'JS'
const name = process.argv[2] ?? "world";
console.log(`Hello, ${name}!`);
JS
