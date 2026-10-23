#!/usr/bin/env bash
: "${LAB_WORKSPACE:?}"
cd "$LAB_WORKSPACE/journal" 2>/dev/null || { echo "journal/ is missing."; exit 1; }
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "journal/ is not a Git repository. Finish step 1 first."
  exit 1
fi
# Staged, or already committed (a learner who comes BACK after step 3 has an
# empty index but day1.md in HEAD).
if git diff --cached --name-only | grep -qx "day1.md"; then
  exit 0
fi
if git rev-parse --verify HEAD >/dev/null 2>&1 && git ls-tree --name-only HEAD | grep -qx "day1.md"; then
  exit 0
fi
echo "day1.md is not staged. Run: git add day1.md"
exit 1
