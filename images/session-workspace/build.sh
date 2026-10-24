#!/usr/bin/env bash
# Build the session-workspace image.
#
#   images/session-workspace/build.sh                 native arch, loaded into the local Docker (tag learning-lab/session-workspace:dev)
#   images/session-workspace/build.sh --push <ref>    linux/amd64 + linux/arm64, pushed to <ref> (ECR in Phase 5)
#
# Run from anywhere; the build context is the repository root.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tag="learning-lab/session-workspace:dev"
openvscode_version="${OPENVSCODE_VERSION:-1.93.1}"

if [ "${1:-}" = "--push" ]; then
  ref="${2:?usage: build.sh --push <registry/repository:tag>}"
  docker buildx build \
    --platform linux/amd64,linux/arm64 \
    --build-arg "OPENVSCODE_VERSION=${openvscode_version}" \
    -f "${root}/images/session-workspace/Dockerfile" \
    -t "${ref}" --push "${root}"
else
  docker buildx build \
    --build-arg "OPENVSCODE_VERSION=${openvscode_version}" \
    -f "${root}/images/session-workspace/Dockerfile" \
    -t "${tag}" --load "${root}"
  echo "built ${tag}"
fi
