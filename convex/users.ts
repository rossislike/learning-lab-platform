import { internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { currentUser, isOperator } from "./access";

function accountFields(identity: {
  subject: string;
  tokenIdentifier: string;
  name?: string;
  email?: string;
  pictureUrl?: string;
}) {
  return {
    clerkSubject: identity.subject,
    tokenIdentifier: identity.tokenIdentifier,
    displayName:
      identity.name?.trim() ||
      identity.email?.trim() ||
      `Learner ${identity.subject.slice(-8)}`,
    ...(identity.email ? { email: identity.email } : {}),
    ...(identity.pictureUrl ? { imageUrl: identity.pictureUrl } : {}),
  };
}

export const syncCurrent = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Authentication required");
    }

    const timestamp = Date.now();
    const fields = accountFields(identity);
    const existing = await ctx.db
      .query("users")
      .withIndex("by_token_identifier", (q) =>
        q.eq("tokenIdentifier", identity.tokenIdentifier)
      )
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        ...fields,
        lastSeenAt: timestamp,
        updatedAt: timestamp,
      });
      return await ctx.db.get(existing._id);
    }

    const accountId = await ctx.db.insert("users", {
      ...fields,
      createdAt: timestamp,
      lastSeenAt: timestamp,
      updatedAt: timestamp,
    });
    return await ctx.db.get(accountId);
  },
});

export const current = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    return await ctx.db
      .query("users")
      .withIndex("by_token_identifier", (q) =>
        q.eq("tokenIdentifier", identity.tokenIdentifier)
      )
      .unique();
  },
});

/** What the app needs about the viewer: the account row and whether it administers the deployment. */
export const viewer = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    const user = identity ? await currentUser(ctx) : null;
    let operator = false;
    try {
      operator = await isOperator(ctx);
    } catch {
      // Not authenticated outside local mode: a plain learner view.
      operator = false;
    }
    return { user, operator };
  },
});

/**
 * Grant or revoke the operator role. CLI only (internal):
 *   CONVEX_DEPLOY_KEY=… npx convex run users:grantOperator '{"email":"you@example.com"}'
 *   CONVEX_DEPLOY_KEY=… npx convex run users:grantOperator '{"email":"…","revoke":true}'
 *   CONVEX_DEPLOY_KEY=… npx convex run users:grantOperator '{"clerkSubject":"user_…"}'
 * (the key pins the dev deployment; locally, without a key, the dev deployment of .env.local is used)
 * (`--prod` → drop it when CONVEX_DEPLOY_KEY is exported.) The account must
 * have signed in once (users.syncCurrent creates the row); an email shared by
 * several accounts is refused, use clerkSubject then.
 */
export const grantOperator = internalMutation({
  args: { email: v.optional(v.string()), clerkSubject: v.optional(v.string()), revoke: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    if (!args.email && !args.clerkSubject) throw new Error("email or clerkSubject is required");
    const uniqueByEmail = async () => {
      const email = args.email!.toLowerCase();
      const matches = (await ctx.db.query("users").collect()).filter(
        (candidate) => candidate.email?.toLowerCase() === email
      );
      if (matches.length > 1) {
        throw new Error(
          `${matches.length} accounts share this email; pass clerkSubject instead (Clerk dashboard → Users → user ID)`
        );
      }
      return matches[0] ?? null;
    };
    const user = args.clerkSubject
      ? await ctx.db
          .query("users")
          .withIndex("by_clerk_subject", (q) => q.eq("clerkSubject", args.clerkSubject!))
          .unique()
      : await uniqueByEmail();
    if (!user) throw new Error("No account matches; the user must sign in once first");
    await ctx.db.patch(user._id, { role: args.revoke ? undefined : "operator", updatedAt: Date.now() });
    return { userId: user._id, displayName: user.displayName, operator: !args.revoke };
  },
});
