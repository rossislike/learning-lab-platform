#!/usr/bin/env bash
set -euo pipefail
: "${LAB_WORKSPACE:?}"
cd "$LAB_WORKSPACE"
for name in IMG_0001.jpg IMG_0002.jpg IMG_0003.jpg; do
  printf 'not really a jpeg\n' > "$name"
done
printf 'Remember to sort the photos.\n' > notes.txt
