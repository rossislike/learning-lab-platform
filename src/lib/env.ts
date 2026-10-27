// Build-time configuration (Vite). Phase 5 sets the hosted values.
export const env = {
  convexUrl: import.meta.env.VITE_CONVEX_URL as string | undefined,
  authMode: (import.meta.env.VITE_AUTH_MODE as string | undefined) ?? "disabled",
  clerkPublishableKey: import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined,
  productSurface: (import.meta.env.VITE_PRODUCT_SURFACE as string | undefined) ?? "local",
  /** Shown in the header and used as the default learner label when auth is disabled. */
  defaultLearnerLabel: (import.meta.env.VITE_LEARNER_LABEL as string | undefined) ?? "learner",
};

export const authConfigured = env.authMode === "configured" && Boolean(env.clerkPublishableKey);
