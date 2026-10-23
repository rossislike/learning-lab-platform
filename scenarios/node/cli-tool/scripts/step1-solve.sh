#!/usr/bin/env bash
set -euo pipefail
: "${LAB_WORKSPACE:?}"
echo 'console.log("Hello, world!");' > "$LAB_WORKSPACE/greet.js"
