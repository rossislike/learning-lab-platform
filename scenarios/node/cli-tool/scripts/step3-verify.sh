#!/usr/bin/env bash
: "${LAB_WORKSPACE:?}"
cd "$LAB_WORKSPACE"
[ -f greet.js ] || { echo "greet.js does not exist yet."; exit 1; }
stderr=$(node greet.js Ada Lovelace 2>&1 >/dev/null)
code=$?
if [ "$code" != "1" ]; then
  echo "node greet.js Ada Lovelace should exit with code 1 but exited with $code."
  exit 1
fi
if ! printf '%s' "$stderr" | grep -q "Usage: node greet.js \[name\]"; then
  echo "The usage message should be printed to stderr. Got:"
  echo "$stderr"
  exit 1
fi
named=$(node greet.js Ada 2>&1) || { echo "node greet.js Ada should still succeed."; exit 1; }
[ "$named" = "Hello, Ada!" ] || { echo "node greet.js Ada should still print 'Hello, Ada!'."; exit 1; }
