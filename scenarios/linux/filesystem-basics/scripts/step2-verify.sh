#!/usr/bin/env bash
: "${LAB_WORKSPACE:?}"
cd "$LAB_WORKSPACE"
if [ ! -d archive ]; then
  echo "There is no archive/ directory. Finish step 1 first."
  exit 1
fi
remaining=$(find . -maxdepth 1 -type f -name '*.jpg' | wc -l | tr -d ' ')
if [ "$remaining" != "0" ]; then
  echo "$remaining .jpg file(s) are still in the working directory. Run: mv *.jpg archive/"
  exit 1
fi
for name in IMG_0001.jpg IMG_0002.jpg IMG_0003.jpg; do
  if [ ! -f "archive/$name" ]; then
    echo "archive/$name is missing. The three photos must all end up inside archive/."
    exit 1
  fi
done
