import { useEffect } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router";
import { SignInButton, UserButton, useUser } from "@clerk/react";
import { useConvexAuth, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { authConfigured, env } from "../lib/env";
import { ErrorBoundary } from "./ErrorBoundary";

function AccountControls() {
  const syncCurrent = useMutation(api.users.syncCurrent);
  const { isSignedIn } = useUser();
  const { isAuthenticated } = useConvexAuth();
  useEffect(() => {
    // Only once Convex has the Clerk token; before that the mutation would run anonymously.
    if (isSignedIn && isAuthenticated) void syncCurrent({}).catch(() => undefined);
  }, [isSignedIn, isAuthenticated, syncCurrent]);
  if (isSignedIn) return <UserButton />;
  return (
    <SignInButton mode="modal">
      <button className="nav-link nav-button">Sign in</button>
    </SignInButton>
  );
}

/**
 * Gate the routed page on a Clerk sign-in and on Convex having accepted the
 * Clerk token (only rendered when auth is configured): queries that need the
 * learner's identity throw until `useConvexAuth().isAuthenticated`.
 */
function SignedInOutlet() {
  const { isLoaded, isSignedIn } = useUser();
  const { isLoading, isAuthenticated } = useConvexAuth();
  if (!isLoaded) return <p className="muted">Loading…</p>;
  if (!isSignedIn) {
    return (
      <section className="notice">
        <h1>Sign in to start a scenario</h1>
        <p>Sessions belong to the signed-in learner; sign in to browse and launch scenarios.</p>
      </section>
    );
  }
  if (isLoading) return <p className="muted">Connecting…</p>;
  if (!isAuthenticated) {
    return (
      <section className="notice">
        <h1>Signed in, but the backend did not accept the session</h1>
        <p>
          Convex rejected the Clerk token. Check the Clerk JWT template named <code>convex</code> and the
          deployment&apos;s <code>CLERK_JWT_ISSUER_DOMAIN</code> (see <code>docs/user-accounts.md</code>).
        </p>
      </section>
    );
  }
  return <Outlet />;
}

export function Layout() {
  const { pathname } = useLocation();
  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand" aria-label="Learning Lab home">
          <span className="brand-mark">LEARNING</span>
          <span className="brand-mark">LAB</span>
        </Link>
        <nav className="topnav">
          <NavLink to="/" end className="nav-link">Areas</NavLink>
          <NavLink to="/admin" className="nav-link">Admin</NavLink>
          {authConfigured ? <AccountControls /> : <span className="nav-muted">{env.defaultLearnerLabel}</span>}
        </nav>
      </header>
      <main className="page">
        <ErrorBoundary key={pathname}>{authConfigured ? <SignedInOutlet /> : <Outlet />}</ErrorBoundary>
      </main>
    </div>
  );
}
