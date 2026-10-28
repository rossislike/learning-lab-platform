#!/usr/bin/env bash
# Build the session-workspace image.
#
#   images/session-workspace/build.sh                 native arch, loaded into the local Docker (tag learning-lab/session-workspace:dev)
#   images/session-workspace/build.sh --push <ref>    linux/amd64 + linux/arm64, pushed to <ref> (ECR in Phase 5)
#
# BUILDX_CACHE (e.g. type=gha in CI, or type=registry,ref=…) adds
# --cache-from/--cache-to <cache>,mode=max to the --push build (gha caches get
# scope=session-workspace).
#
# PLATFORMS overrides the --push platforms (e.g. PLATFORMS=linux/amd64). A
# multi-platform push needs a docker-container builder
# (`docker buildx create --name llp --use`) and, for the non-native
# platform, QEMU emulation (Docker Desktop ships it).
#
# Run from anywhere; the build context is the repository root.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tag="learning-lab/session-workspace:dev"
openvscode_version="${OPENVSCODE_VERSION:-1.93.1}"

if [ "${1:-}" = "--push" ]; then
  ref="${2:?usage: build.sh --push <registry/repository:tag>}"
  cache_args=()
  if [ -n "${BUILDX_CACHE:-}" ]; then
    cache="${BUILDX_CACHE}"
    case "${cache}" in
      type=gha*) case ",${cache}" in *,scope=*) ;; *) cache="${cache},scope=session-workspace" ;; esac ;;
    esac
    cache_args=(--cache-from "${cache}" --cache-to "${cache},mode=max")
  fi
  # ${cache_args[@]+…}: an empty array is "unbound" under set -u in bash 3.2 (macOS).
  docker buildx build \
    --platform "${PLATFORMS:-linux/amd64,linux/arm64}" \
    --build-arg "OPENVSCODE_VERSION=${openvscode_version}" \
    ${cache_args[@]+"${cache_args[@]}"} \
    -f "${root}/images/session-workspace/Dockerfile" \
    -t "${ref}" --push "${root}"
else
  docker buildx build \
    --build-arg "OPENVSCODE_VERSION=${openvscode_version}" \
    -f "${root}/images/session-workspace/Dockerfile" \
    -t "${tag}" --load "${root}"
  echo "built ${tag}"
fi
