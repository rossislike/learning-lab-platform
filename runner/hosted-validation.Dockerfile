FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0

WORKDIR /app

COPY --chown=node:node scripts/smoke-test-scenarios.mjs scripts/smoke-test-scenarios.mjs
COPY --chown=node:node lab-definitions lab-definitions

ENV NODE_ENV=development

CMD ["node", "scripts/smoke-test-scenarios.mjs", "--scenario", "react-welcome-message"]
