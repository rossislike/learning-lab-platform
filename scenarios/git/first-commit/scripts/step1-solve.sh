#!/usr/bin/env bash
set -euo pipefail
: "${LAB_WORKSPACE:?}"
git -C "$LAB_WORKSPACE/journal" init -q
