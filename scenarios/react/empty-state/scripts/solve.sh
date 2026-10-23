#!/usr/bin/env bash
set -euo pipefail
: "${LAB_WORKSPACE:?}"
cp -R "$LAB_SCENARIO_DIR/solution/src/." "$LAB_WORKSPACE/src/"
