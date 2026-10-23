#!/usr/bin/env bash
set -euo pipefail
: "${LAB_WORKSPACE:?}"
git -C "$LAB_WORKSPACE/journal" add day1.md
