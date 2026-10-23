#!/usr/bin/env bash
: "${LAB_WORKSPACE:?}"
file="$LAB_WORKSPACE/archive/README.txt"
if [ ! -f "$file" ]; then
  echo "archive/README.txt does not exist. Create it with echo and >."
  exit 1
fi
if ! grep -qi "archived" "$file"; then
  echo "archive/README.txt must contain the word 'archived'."
  exit 1
fi
