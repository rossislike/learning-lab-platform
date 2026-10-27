import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { ClerkProvider, useAuth } from "@clerk/react";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { env } from "./lib/env";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Layout } from "./components/Layout";
import { AreasPage } from "./pages/AreasPage";
import { AreaPage } from "./pages/AreaPage";
import { ScenarioPage } from "./pages/ScenarioPage";
import { AdminPage } from "./pages/AdminPage";
import { SetupPage } from "./pages/SetupPage";
import "./app.css";

const convex = env.convexUrl ? new ConvexReactClient(env.convexUrl) : null;

function Router() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<AreasPage />} />
          <Route path="admin" element={<AdminPage />} />
          <Route path=":area" element={<AreaPage />} />
          <Route path=":area/:slug" element={<ScenarioPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

function Root() {
  if (!env.convexUrl || !convex) {
    return <SetupPage problem="VITE_CONVEX_URL is not set. Run `npx convex dev` and copy the printed URL into .env.local." />;
  }
  if (env.authMode === "configured") {
    if (!env.clerkPublishableKey) {
      return <SetupPage problem="VITE_AUTH_MODE=configured requires VITE_CLERK_PUBLISHABLE_KEY." />;
    }
    return (
      <ClerkProvider publishableKey={env.clerkPublishableKey}>
        <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
          <Router />
        </ConvexProviderWithClerk>
      </ClerkProvider>
    );
  }
  return (
    <ConvexProvider client={convex}>
      <Router />
    </ConvexProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <Root />
    </ErrorBoundary>
  </StrictMode>
);
