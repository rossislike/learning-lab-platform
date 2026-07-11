import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ClerkProvider, useAuth } from "@clerk/react";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import App from "./App";
import "./styles.css";

const convexUrl = import.meta.env.VITE_CONVEX_URL as string | undefined;
const productSurface = import.meta.env.VITE_PRODUCT_SURFACE as string | undefined;
const authMode = import.meta.env.VITE_AUTH_MODE as string | undefined;
const sessionAccessMode = import.meta.env.VITE_SESSION_ACCESS_MODE as string | undefined;
const costControlsMode = import.meta.env.VITE_COST_CONTROLS_MODE as string | undefined;
const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as
  | string
  | undefined;

const convex = convexUrl ? new ConvexReactClient(convexUrl) : null;

function configuredApp() {
  if (!convexUrl || !convex) {
    return <App missingConvexUrl />;
  }

  const app = (
    <App
      authMode={authMode}
      clerkConfigured={Boolean(clerkPublishableKey)}
      convexUrl={convexUrl}
      costControlsMode={costControlsMode}
      productSurface={productSurface}
      sessionAccessMode={sessionAccessMode}
    />
  );

  if (authMode === "configured") {
    if (!clerkPublishableKey) {
      return app;
    }

    return (
      <ClerkProvider publishableKey={clerkPublishableKey}>
        <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
          {app}
        </ConvexProviderWithClerk>
      </ClerkProvider>
    );
  }

  return <ConvexProvider client={convex}>{app}</ConvexProvider>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>{configuredApp()}</StrictMode>
);
