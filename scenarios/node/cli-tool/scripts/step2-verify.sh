#!/usr/bin/env bash
: "${LAB_WORKSPACE:?}"
cd "$LAB_WORKSPACE"
[ -f greet.js ] || { echo "greet.js does not exist yet."; exit 1; }
named=$(node greet.js Ada 2>&1) || { echo "node greet.js Ada exited with an error:"; echo "$named"; exit 1; }
if [ "$named" != "Hello, Ada!" ]; then
  echo "node greet.js Ada should print 'Hello, Ada!' but printed:"
  echo "$named"
  exit 1
fi
plain=$(node greet.js 2>&1) || { echo "node greet.js exited with an error:"; echo "$plain"; exit 1; }
if [ "$plain" != "Hello, world!" ]; then
  echo "node greet.js with no argument should still print 'Hello, world!' but printed:"
  echo "$plain"
  exit 1
fi
