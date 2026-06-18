import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

const convexUrl = import.meta.env.VITE_CONVEX_URL as string | undefined;
const productSurface = import.meta.env.VITE_PRODUCT_SURFACE as string | undefined;
const authMode = import.meta.env.VITE_AUTH_MODE as string | undefined;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {convexUrl ? (
      <App authMode={authMode} convexUrl={convexUrl} productSurface={productSurface} />
    ) : (
      <App missingConvexUrl />
    )}
  </StrictMode>
);
