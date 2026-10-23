#!/usr/bin/env bash
: "${LAB_WORKSPACE:?}"
if [ ! -d "$LAB_WORKSPACE/archive" ]; then
  echo "There is no archive/ directory yet. Run: mkdir archive"
  exit 1
fi
