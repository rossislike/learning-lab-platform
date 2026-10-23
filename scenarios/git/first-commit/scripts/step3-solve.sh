#!/usr/bin/env bash
set -euo pipefail
: "${LAB_WORKSPACE:?}"
git -C "$LAB_WORKSPACE/journal" commit -q -m "Add first journal entry"
