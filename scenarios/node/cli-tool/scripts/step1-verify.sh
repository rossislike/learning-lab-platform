#!/usr/bin/env bash
: "${LAB_WORKSPACE:?}"
cd "$LAB_WORKSPACE"
if [ ! -f greet.js ]; then
  echo "greet.js does not exist yet."
  exit 1
fi
output=$(node greet.js 2>&1) || { echo "node greet.js exited with an error:"; echo "$output"; exit 1; }
if [ "$output" != "Hello, world!" ]; then
  echo "Expected the output to be exactly 'Hello, world!' but got:"
  echo "$output"
  exit 1
fi
