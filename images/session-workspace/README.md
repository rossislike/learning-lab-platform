# session-workspace image

One container per learner session (ADR 0005). Contents:

- Debian bookworm (`node:22-bookworm-slim`) with bash, git, curl, jq, nano, vim-tiny, tree, procps, `tini` as PID 1. No sudo: `workspace.user: root` scenarios run the whole container as uid 0 (`runAsUser`, set by the dispatcher).
- Node 22 and npm.
- OpenVSCode server at `/opt/openvscode-server`, started by the agent on `127.0.0.1:3000` with `--server-base-path /editor` when the scenario has an `editor` tab.
- The session agent at `/opt/agent` (`runner/session-agent/`), listening on `:7000`.
- Non-root user `learner` (uid 1001), `HOME=/home/learner`, `/workspace` and `/scenario` owned by it.

Ports: `7000` agent (terminals, steps, `/editor/*`), `5173` Vite preview for react scenarios (routed by port, not through the agent). OpenVSCode listens on loopback `3000` only and is not exposed.

The `agent-deps` stage runs `npm ci` when `runner/session-agent/package-lock.json` exists and `npm install` otherwise (generating the lockfile is an open Phase 2 item). `.dockerignore` keeps `node_modules`, `*.test.mjs`, `build/` and `lab-workspaces/` out of the context.

## Build

```bash
images/session-workspace/build.sh                     # local, native arch
images/session-workspace/build.sh --push <ecr-ref>    # multi-arch, pushed
```

## Try it

```bash
docker run --rm -p 7000:7000 -p 5173:5173 \
  -v "$PWD/scenarios/git/first-commit:/scenario:ro" \
  learning-lab/session-workspace:dev
# open http://localhost:7000/  → development xterm.js page (served only when SESSION_TOKEN is unset)
```

The integration test does this for you and checks every endpoint:

```bash
npm run agent:integration                       # git/first-commit
npm run agent:integration -- --scenario welcome-message   # react: editor + preview too
```

Environment the dispatcher sets (Phase 3): `CONVEX_URL`, `SESSION_ID`,
`SESSION_TOKEN` (from `sessions.issueAgentToken`); without them the agent
runs standalone, keeps step results local, and serves the development page.
The full contract is in `runner/README.md` ("Contract for the dispatcher and
gateway").
