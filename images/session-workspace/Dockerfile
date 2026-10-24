# syntax=docker/dockerfile:1.7
# Session workspace image (ADR 0005): one container per learner session.
# Runs the session agent (terminals over WebSocket, scenario step scripts,
# OpenVSCode proxy). Built for linux/amd64 and linux/arm64.

ARG NODE_IMAGE=node:22-bookworm-slim

# --- agent dependencies (node-pty needs a native build) ----------------------
FROM ${NODE_IMAGE} AS agent-deps
WORKDIR /opt/agent
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY runner/session-agent/package.json runner/session-agent/package-lock.json* ./
# `npm ci` once runner/session-agent/package-lock.json exists (ROADMAP Phase 2
# open item); `npm install` until then.
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --no-audit --no-fund --loglevel=error; \
    else \
      npm install --omit=dev --no-audit --no-fund --loglevel=error; \
    fi

# --- runtime -----------------------------------------------------------------
FROM ${NODE_IMAGE}
ARG TARGETARCH
ARG OPENVSCODE_VERSION=1.93.1

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git jq less nano openssh-client procps tini tree unzip vim-tiny \
  && rm -rf /var/lib/apt/lists/*

# OpenVSCode server, served by the agent under /editor (--server-base-path).
RUN set -eux; \
  case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
    amd64) arch=x64 ;; \
    arm64) arch=arm64 ;; \
    *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
  esac; \
  url="https://github.com/gitpod-io/openvscode-server/releases/download/openvscode-server-v${OPENVSCODE_VERSION}/openvscode-server-v${OPENVSCODE_VERSION}-linux-${arch}.tar.gz"; \
  curl -fsSL "$url" | tar -xz -C /opt; \
  mv "/opt/openvscode-server-v${OPENVSCODE_VERSION}-linux-${arch}" /opt/openvscode-server; \
  ln -s /opt/openvscode-server/bin/openvscode-server /usr/local/bin/openvscode-server

# Non-root learner. Scenarios with workspace.user=root run with runAsUser 0
# set by the dispatcher (in-container only; no host privileges either way);
# the agent then uses HOME=/root for shells and scripts. No sudo: the learner
# either is root for the whole session or is not.
RUN groupadd -g 1001 learner \
  && useradd -m -u 1001 -g learner -s /bin/bash learner \
  && mkdir -p /workspace /scenario \
  && chown learner:learner /workspace /scenario \
  && git config --system init.defaultBranch main

COPY --from=agent-deps /opt/agent/node_modules /opt/agent/node_modules
COPY runner/session-agent /opt/agent

ENV LAB_SCENARIO_DIR=/scenario \
    AGENT_PORT=7000 \
    EDITOR_PORT=3000 \
    OPENVSCODE_SERVER_BIN=/usr/local/bin/openvscode-server \
    HOME=/home/learner \
    LANG=C.UTF-8

USER learner
WORKDIR /workspace
# 7000 agent (terminals, steps, /editor/*); 5173 Vite preview, routed by port.
# OpenVSCode (3000) is loopback-only behind the agent and is not exposed.
EXPOSE 7000 5173
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=3 \
  CMD curl -fsS http://127.0.0.1:7000/healthz || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/opt/agent/agent.mjs"]
