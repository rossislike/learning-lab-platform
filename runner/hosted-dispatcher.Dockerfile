FROM node:24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS build

WORKDIR /build

COPY --chown=node:node runner/dispatcher-runtime/package.json runner/dispatcher-runtime/package-lock.json ./
RUN npm ci \
  && npm cache clean --force

COPY --chown=node:node convex/_generated/api.js convex/_generated/api.js
COPY --chown=node:node runner/aws-runner.mjs runner/aws-runner.mjs
COPY --chown=node:node runner/aws-ecs-fargate-runner.mjs runner/aws-ecs-fargate-runner.mjs
COPY --chown=node:node runner/startup-cancellation.mjs runner/startup-cancellation.mjs

RUN ./node_modules/.bin/esbuild runner/aws-runner.mjs \
  --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" \
  --bundle \
  --format=esm \
  --minify \
  --outfile=dispatcher.mjs \
  --platform=node \
  --target=node24

FROM node:24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS runtime

WORKDIR /app

COPY --from=build --chown=node:node /build/dispatcher.mjs dispatcher.mjs

ENV NODE_ENV=production

USER node

STOPSIGNAL SIGTERM

ENTRYPOINT ["node", "dispatcher.mjs"]
