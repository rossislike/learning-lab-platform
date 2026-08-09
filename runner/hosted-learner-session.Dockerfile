FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS templates

WORKDIR /source
COPY runner/package-learner-templates.mjs runner/package-learner-templates.mjs
COPY lab-definitions lab-definitions
RUN node runner/package-learner-templates.mjs lab-definitions /learner-lab-definitions

FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS runtime

ARG OPENVSCODE_SERVER_VERSION
ARG OPENVSCODE_SERVER_ARCH=arm64
ARG OPENVSCODE_SERVER_SHA256

USER root
WORKDIR /app

RUN test -n "${OPENVSCODE_SERVER_VERSION}" \
  && test -n "${OPENVSCODE_SERVER_SHA256}" \
  && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git procps tar \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL \
    "https://github.com/gitpod-io/openvscode-server/releases/download/openvscode-server-v${OPENVSCODE_SERVER_VERSION}/openvscode-server-v${OPENVSCODE_SERVER_VERSION}-linux-${OPENVSCODE_SERVER_ARCH}.tar.gz" \
    -o /tmp/openvscode-server.tar.gz \
  && echo "${OPENVSCODE_SERVER_SHA256}  /tmp/openvscode-server.tar.gz" | sha256sum -c - \
  && mkdir -p /opt/openvscode-server /workspace \
  && tar -xzf /tmp/openvscode-server.tar.gz -C /opt/openvscode-server --strip-components=1 \
  && ln -s /opt/openvscode-server/bin/openvscode-server /usr/local/bin/openvscode-server \
  && chown -R node:node /app /workspace /opt/openvscode-server \
  && rm /tmp/openvscode-server.tar.gz

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node convex/_generated convex/_generated
COPY --chown=node:node runner/workspace-server.mjs runner/workspace-server.mjs
COPY --chown=node:node runner/hosted-learner-entrypoint.mjs runner/hosted-learner-entrypoint.mjs
COPY --chown=node:node runner/hosted-learner-healthcheck.mjs runner/hosted-learner-healthcheck.mjs
COPY --chown=node:node runner/learner-process-env.mjs runner/learner-process-env.mjs
COPY --from=templates --chown=node:node /learner-lab-definitions lab-definitions

ENV NODE_ENV=production
ENV LAB_WORKSPACE_ROOT=/workspace
ENV LAB_EDITOR_PORT=3000
ENV LAB_PREVIEW_PORT=5173
ENV LAB_TOOLS_PORT=8080

EXPOSE 3000 5173 8080

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "runner/hosted-learner-healthcheck.mjs"]

ENTRYPOINT ["node", "runner/hosted-learner-entrypoint.mjs"]
