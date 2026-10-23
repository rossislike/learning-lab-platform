#!/usr/bin/env bash
: "${LAB_WORKSPACE:?}"
cd "$LAB_WORKSPACE/journal" 2>/dev/null || { echo "journal/ is missing."; exit 1; }
if ! git rev-parse --verify HEAD >/dev/null 2>&1; then
  echo "No commits yet. Run: git commit -m \"Add first journal entry\""
  exit 1
fi
if ! git ls-tree --name-only HEAD | grep -qx "day1.md"; then
  echo "The commit does not contain day1.md. Stage it with git add day1.md and commit again."
  exit 1
fi
