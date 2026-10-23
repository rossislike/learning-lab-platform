#!/usr/bin/env bash
set -euo pipefail
: "${LAB_WORKSPACE:?}"
mkdir -p "$LAB_WORKSPACE/journal"
cat > "$LAB_WORKSPACE/journal/day1.md" <<'MD'
# Day 1

Started learning Git today. First goal: one commit.
MD
# Make sure commits work even if the learner never configures an identity.
git config --global user.name >/dev/null 2>&1 || git config --global user.name "Learner"
git config --global user.email >/dev/null 2>&1 || git config --global user.email "learner@example.com"
git config --global init.defaultBranch main >/dev/null 2>&1 || true
