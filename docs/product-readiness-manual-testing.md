# Product Readiness Manual Testing

Use this checklist to verify the Product Readiness work: personas, self-serve surface decision, hosted security gates, course/module structure, observability, and cost controls.

## Preflight

1. Install dependencies if needed:

   ```bash
   npm install
   ```

2. Confirm local environment defaults:

   ```text
   VITE_PRODUCT_SURFACE=local
   VITE_AUTH_MODE=disabled
   VITE_SESSION_ACCESS_MODE=local-only
   VITE_COST_CONTROLS_MODE=local-limits
   ```

3. Start the local stack:

   ```bash
   npm run dev:all
   ```

4. Open the dashboard:

   ```text
   http://127.0.0.1:5174/
   ```

## Personas And Self-Serve Surface

1. Open [docs/product-readiness.md](docs/product-readiness.md).
2. Confirm the personas are defined as:
   - Learner: primary self-serve user.
   - Operator: minimized support/platform role.
   - Author: scenario content maintainer.
3. Confirm `First Product Surface` says the first surface is self-serve.
4. Confirm the default flow says selecting an exercise should automatically start session/workspace/editor/preview/tools/progress setup.
5. Confirm the flow says the learner can stop or exit at any time.

## Hosted Security Gates

These checks verify that hosted/public mode cannot start without auth, authorization, and cost controls.

1. Stop any running dashboard process.
2. Start the dashboard with hosted mode and missing auth:

   ```bash
   VITE_PRODUCT_SURFACE=hosted VITE_AUTH_MODE=disabled npm run dev
   ```

3. Open the dashboard.
4. Confirm the app shows `Hosted security gate blocked startup`.
5. Stop the dashboard.
6. Start with auth configured but session access still local-only:

   ```bash
   VITE_PRODUCT_SURFACE=hosted VITE_AUTH_MODE=configured VITE_SESSION_ACCESS_MODE=local-only npm run dev
   ```

7. Confirm startup is still blocked for session access authorization.
8. Stop the dashboard.
9. Start with auth and session access configured but cost controls not enforced:

   ```bash
   VITE_PRODUCT_SURFACE=hosted VITE_AUTH_MODE=configured VITE_SESSION_ACCESS_MODE=authorized VITE_COST_CONTROLS_MODE=local-limits npm run dev
   ```

10. Confirm startup is still blocked for hosted cost controls.
11. Stop the dashboard.
12. Start with all hosted gates configured:

   ```bash
   VITE_PRODUCT_SURFACE=hosted VITE_AUTH_MODE=configured VITE_SESSION_ACCESS_MODE=authorized VITE_COST_CONTROLS_MODE=enforced npm run dev
   ```

13. Confirm the normal dashboard loads.

## Course And Module Structure

1. Start Convex if it is not already running:

   ```bash
   npx convex dev
   ```

2. In the dashboard, click `Seed scenarios`.
3. Confirm courses exist:

   ```bash
   npx convex run courses:list '{}'
   ```

4. Confirm the output includes `React Labs`.
5. Confirm modules exist:

   ```bash
   npx convex run courses:listModules '{}'
   ```

6. Confirm modules are derived from scenario domain metadata.
7. Confirm labs have course/module IDs:

   ```bash
   npx convex run labs:list '{}'
   ```

8. Confirm each seeded scenario includes `courseId` and `moduleId`.

## Observability

1. Create a session from the dashboard.
2. Wait for it to reach `running`.
3. Run checks at least once.
4. Stop the session and let the runner clean it up.
5. Confirm the runner health panel shows:
   - `Avg startup`
   - `Avg validation`
   - `Failure rate`
   - `Avg cleanup`
6. Confirm the observability query returns summary data:

   ```bash
   npx convex run observability:sessionSummary '{}'
   ```

7. Confirm the summary includes `averageStartupMs`, `averageValidationMs`, `failureRate`, and `averageCleanupMs` when there is enough session data.

## Cost Controls

1. Request local sessions until there are 5 active sessions across `requested`, `starting`, `running`, and `checking`.
2. Attempt to request a sixth local session.
3. Confirm the request fails with:

   ```text
   Local session limit reached (5 active sessions)
   ```

4. Confirm session TTL remains capped at 1 hour:

   ```bash
   npx convex run sessions:list '{}'
   ```

5. Confirm newly requested sessions have `ttlSeconds` no greater than `3600`.

## Final Verification

Run:

```bash
npm run lint
npm run build
```

Expected result:

- All `Product Readiness` items in `ROADMAP.md` are checked.
- Hosted/public mode is blocked unless auth, session access, and cost controls are configured.
- Seeding creates course and module records above scenarios.
- Runner health includes observability metrics.
- Local session cost controls cap active sessions and TTL.
