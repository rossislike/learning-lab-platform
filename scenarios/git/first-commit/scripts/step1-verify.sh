#!/usr/bin/env bash
: "${LAB_WORKSPACE:?}"
if [ ! -d "$LAB_WORKSPACE/journal/.git" ]; then
  echo "journal/ is not a Git repository yet. Run: cd journal && git init"
  exit 1
fi
