# Session And Progress Model Manual Testing

Use this checklist to verify the dashboard changes for session filtering, scenario history, completion timestamps, completed-workspace retention, attempt summaries, and durable progress records.

## Preflight

1. Install dependencies if needed:

   ```bash
   npm install
   ```

2. Start the local stack:

   ```bash
   npm run dev:all
   ```

   `dev:all` uses the Docker/OpenVSCode editor by default. To force the lightweight fallback editor, run:

   ```bash
   LOCAL_EDITOR_PROVIDER=lightweight npm run dev:all
   ```

3. Open the dashboard:

   ```text
   http://127.0.0.1:5174/
   ```

4. Click `Seed scenarios`.

## Test Data Setup

Create at least three sessions so each filter and summary has useful data:

1. Select `Update Welcome Message`.
2. Set learner label to `alice-filter`.
3. Click `Request session`.
4. Select `Optimize Product Dashboard`.
5. Set learner label to `bob-filter`.
6. Click `Request session`.
7. Select `Update Welcome Message` again.
8. Set learner label to `carol-filter`.
9. Click `Request session`.

Wait for the local runner to move the requested sessions into `running`. If they remain `requested`, confirm the runner is still active or run:

```bash
npm run runner:local:once
```

## Session Filters

1. In `Recent sessions`, set the `Scenario` filter to `Update Welcome Message`.
2. Confirm only `alice-filter` and `carol-filter` rows remain.
3. Set `Scenario` back to `All scenarios`.
4. Set the `Status` filter to `running`.
5. Confirm only running sessions remain.
6. Type `bob` into the `Learner` filter.
7. Confirm only `bob-filter` remains.
8. Combine filters, for example `Optimize Product Dashboard` plus learner `bob`, and confirm the list narrows correctly.
9. Enter a learner value that does not exist.
10. Confirm the empty state says no sessions match the current filters.

## Per-Scenario Session History

1. Select the `Update Welcome Message` scenario card.
2. Confirm the `Scenario history` panel shows only sessions for that scenario.
3. Confirm the newest session appears first.
4. Click a row in the history panel.
5. Confirm the `Session detail` panel updates to the selected session.
6. Select `Optimize Product Dashboard`.
7. Confirm the history panel switches to only that scenario's sessions.

## Completed-At Timestamp And Retention Window

1. Open a running `Update Welcome Message` session.
2. Open the workspace editor and change the starter app heading to:

   ```text
   Welcome to React Labs
   ```

3. Save the file.
4. Click `Run checks`.
5. Confirm the session status becomes `passed`.
6. In `Session detail`, confirm `Completed` shows a timestamp instead of `-`.
7. Confirm `Expires` moved to roughly 30 minutes after `Completed`.
8. Run this spot check:

   ```bash
   npx convex run sessions:list '{}'
   ```

9. Confirm the passed session has `completedAt` and an `expiresAt` value about 30 minutes later.

## Attempt Summaries Per Scenario

1. Review each scenario card.
2. Confirm each card shows attempt count, passed count, and best score.
3. After the passing run above, confirm `Update Welcome Message` shows at least one passed attempt and `Best 100%`.
4. Select `Update Welcome Message`.
5. Confirm the `Scenario history` header shows the same attempt count, passed count, and best score.
6. Create another attempt for the same scenario and run checks again.
7. Confirm the attempt count increments while the best score remains the highest observed score.

## Durable Progress Records

Progress records should persist independently from disposable session runtime state.

1. Run:

   ```bash
   npx convex run progress:list '{}'
   ```

2. Confirm there is one `progressRecords` row for each requested session.
3. Confirm each row includes `labId`, `sessionId`, `learnerLabel`, `status`, `startedAt`, `createdAt`, and `updatedAt`.
4. Confirm the passed attempt includes `score`, `summary`, and `completedAt`.
5. In the dashboard, click `Remove` on a passed session in `Recent sessions`.
6. Confirm the session disappears from `Recent sessions`.
7. Run:

   ```bash
   npx convex run progress:list '{}'
   ```

8. Confirm the progress record for the removed session still exists.
9. Confirm the scenario card attempt summary still includes the removed session.
10. Stop or expire a session, then let the runner clean it up.
11. Confirm cleanup metadata changes on the session, but the progress record remains available.

## Final Verification

Run these commands before considering the manual pass complete:

```bash
npm run lint
npm run build
```

Expected result:

- All `Session And Progress Model` items in `ROADMAP.md` are checked.
- Session filters narrow the recent-session list by scenario, status, and learner label.
- Scenario history follows the selected scenario and opens selected sessions.
- Passing checks record `completedAt`.
- Completed local workspaces remain inspectable for about 30 minutes after passing.
- Scenario cards and history headers show attempt summaries from durable progress records.
- Removing or cleaning session runtime state does not remove progress records.
