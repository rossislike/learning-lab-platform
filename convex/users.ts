import { mutation, query } from "./_generated/server";

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
