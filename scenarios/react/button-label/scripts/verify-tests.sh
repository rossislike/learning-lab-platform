#!/usr/bin/env bash
: "${LAB_WORKSPACE:?}"
cd "$LAB_WORKSPACE"
# The checks always run against the scenario's own tests, restored from the
# read-only bundle, so edits to tests/ in the workspace cannot pass them.
if [ -n "${LAB_SCENARIO_DIR:-}" ]; then
  if [ -d "$LAB_SCENARIO_DIR/workspace/tests" ]; then
    mkdir -p tests
    cp -R "$LAB_SCENARIO_DIR/workspace/tests/." tests/
  fi
  if [ -f "$LAB_SCENARIO_DIR/workspace/setupTests.js" ]; then
    cp "$LAB_SCENARIO_DIR/workspace/setupTests.js" setupTests.js
  fi
fi
if output=$(npm test -- --run 2>&1); then
  exit 0
fi
echo "The checks did not pass yet. Save your file and try again."
echo
echo "$output" | grep -vE "^\s*$" | tail -30
exit 1
