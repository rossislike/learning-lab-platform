#!/usr/bin/env bash
set -euo pipefail
: "${LAB_WORKSPACE:?}"
cd "$LAB_WORKSPACE"
npm ci --no-audit --no-fund --loglevel=error
