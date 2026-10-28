# User accounts with Clerk

Clerk is the identity provider for hosted user accounts. Convex validates Clerk session tokens and stores the application account record.

## Clerk setup

1. Create the Clerk application and choose the allowed sign-in methods.
2. Create a Clerk JWT template named `convex` from the Clerk Dashboard's
   **JWT templates** page or through the authenticated Clerk API. Set its `aud`
   claim to `convex` and include only the trusted profile claims used by the
   account record:

   ```json
   {
     "aud": "convex",
     "name": "{{user.first_name}}",
     "email": "{{user.primary_email_address}}",
     "picture": "{{user.image_url}}"
   }
   ```

   Use `RS256`, a 60-second token lifetime, a 5-second allowed clock skew, and
   Clerk-managed signing keys with custom signing keys disabled. The Clerk
   development instance used by `local` and `dev` was remotely verified with
   this exact configuration on 2026-08-15.

3. Copy the Clerk publishable key into `.env.local`:

   ```text
   VITE_AUTH_MODE=configured
   VITE_CLERK_PUBLISHABLE_KEY=pk_test_REPLACE_ME
   ```

4. Copy the Clerk Frontend API URL from the Clerk API keys page. Set it on the Convex development deployment:

   ```sh
   npx convex env set CLERK_JWT_ISSUER_DOMAIN https://REPLACE_ME.clerk.accounts.dev
   ```

5. Run `npx convex dev` so `convex/auth.config.ts`, the user table, and account functions are deployed.

Also set `RUNNER_SHARED_SECRET` to the same long random value in Convex and in
the dispatcher/gateway deployment (the Helm chart's `runnerSecret`). For local
development, place it in the ignored `.env.local`; `npm run cluster:up` (and
`npm run dev:all`, which runs it) reads it from there into the chart's Secret
without logging it. Runner-only lifecycle functions reject calls that do not
supply this value. Set `ALLOW_UNAUTHENTICATED_LOCAL_MODE=true`
only on an isolated local Convex deployment. Remove it or set it to `false` on
hosted deployments.

When the issuer variable is absent, Convex deploys with no external auth
provider. Configured frontend mode remains blocked unless the Clerk publishable
key is present, and authenticated Convex calls will not succeed until the
issuer is configured.

Both `local` and `dev` use the Clerk development instance recorded in
`config/hosted-environments.json`. The production Clerk instance is parked
(see the `parked` block there) and is not wired to any environment.

## Account lifecycle

`ClerkProvider` owns the browser sign-in session. `ConvexProviderWithClerk` obtains and refreshes the Clerk token, then Convex validates it against the configured issuer.

After the first validated sign-in, `users.syncCurrent` creates a user row keyed by Convex's globally unique `tokenIdentifier`. Later visits update display fields and `lastSeenAt`. The row stores:

- the immutable Clerk subject;
- the issuer-scoped token identifier;
- display name, email, and image when present in validated claims;
- creation, update, and last-seen timestamps.

Session requests never accept a client-supplied owner subject. Convex derives `ownerSubject` and the session owner key from the validated identity. Auth-disabled local development continues to use the normalized learner label.

Learner-facing session, event, progress, and observability functions require a
validated identity and filter records by its issuer-scoped token identifier.
Mutation functions that act on an existing session verify the same ownership.
The unauthenticated local escape hatch is deployment-controlled, not a browser
argument. Never enable it on a deployment reachable by hosted clients.

## User deletion and retained learning data

Deleting a user in Clerk does not automatically delete the corresponding
Convex account or learning records. Until a signed Clerk webhook endpoint is
implemented, deletion is an operator procedure:

1. Verify a deletion request using the Clerk user ID in the Clerk Dashboard.
2. Stop and clean up any active sessions owned by that subject.
3. Export learning records if retention or portability policy requires it.
4. Delete or anonymize the matching `users`, `sessions`, `sessionEvents`, and
   `progressRecords` documents in Convex according to the product retention
   policy.
5. Record only the audit metadata required by policy, without retaining email,
   name, image URL, or workspace contents.

Do not claim automatic deletion until a webhook verifies Clerk's signature,
handles retries idempotently, and cascades or anonymizes records transactionally.

Clerk remains the source of truth for credentials, verification, sessions, and account-management UI. Convex is the source of truth for learning data and its relationship to the authenticated subject. Do not store Clerk secret keys in Vite variables or Convex documents.

Organizations, enrollment, and role-based authorization are separate roadmap tasks.

## Operators

Administrative pages and mutations (`/admin`, `labs.seedScenarios`,
`sessions.listAll`, stopping another learner's session) require the
`operator` role on the `users` row. Grant it from the CLI once the account
has signed in (`users.syncCurrent` creates the row):

```sh
npx convex run users:grantOperator '{"email":"you@example.com"}'          # local dev deployment
npx convex run users:grantOperator '{"email":"you@example.com"}' --prod   # dev (upbeat-crab-254)
```

With `CONVEX_DEPLOY_KEY` exported (the dev deploy key), drop `--prod`: the key
already pins the deployment. When several accounts share the email the
mutation refuses; pass `{"clerkSubject":"user_…"}` (the Clerk user ID) instead.
Operators can stop any session and read its status and events, but never get
workspace or step access to another learner's session.

With `ALLOW_UNAUTHENTICATED_LOCAL_MODE=true` (local only) every visitor is an operator.
