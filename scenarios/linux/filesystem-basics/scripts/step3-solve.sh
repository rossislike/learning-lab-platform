#!/usr/bin/env bash
set -euo pipefail
: "${LAB_WORKSPACE:?}"
echo "Photos archived on day one." > "$LAB_WORKSPACE/archive/README.txt"
