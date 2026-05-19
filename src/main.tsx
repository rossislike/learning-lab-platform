import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

const convexUrl = import.meta.env.VITE_CONVEX_URL as string | undefined;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {convexUrl ? (
      <App convexUrl={convexUrl} />
    ) : (
      <App missingConvexUrl />
    )}
  </StrictMode>
);
