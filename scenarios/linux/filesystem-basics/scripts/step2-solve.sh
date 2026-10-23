#!/usr/bin/env bash
set -euo pipefail
: "${LAB_WORKSPACE:?}"
cd "$LAB_WORKSPACE"
mv ./*.jpg archive/
