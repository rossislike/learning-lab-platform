# syntax=docker/dockerfile:1.7
# Platform image: the Kubernetes dispatcher and the session gateway.
# Both are dependency-free Node programs; the command is set per Deployment.
FROM node:22-bookworm-slim
WORKDIR /app
COPY runner/shared /app/runner/shared
COPY runner/dispatcher /app/runner/dispatcher
COPY runner/gateway /app/runner/gateway
COPY runner/session-agent/public /app/runner/session-agent/public
RUN chmod -R a+rX /app && find /app -name "*.test.mjs" -delete
USER node
ENV NODE_ENV=production
CMD ["node", "/app/runner/gateway/main.mjs"]
