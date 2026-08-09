FROM node:24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03

WORKDIR /app

COPY --chown=node:node runner/session-gateway.mjs runner/session-gateway.mjs
COPY --chown=node:node runner/hosted-session-gateway-healthcheck.mjs runner/hosted-session-gateway-healthcheck.mjs

ENV NODE_ENV=production
ENV SESSION_GATEWAY_HOST=0.0.0.0
ENV SESSION_GATEWAY_PORT=8080

EXPOSE 8080

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["node", "runner/hosted-session-gateway-healthcheck.mjs"]

STOPSIGNAL SIGTERM

ENTRYPOINT ["node", "runner/session-gateway.mjs"]
