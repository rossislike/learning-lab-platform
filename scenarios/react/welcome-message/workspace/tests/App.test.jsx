import { StrictMode } from "react";
import { render, screen } from "../test-utils/custom-render.jsx";
import { describe, expect, it } from "vitest";
import App from "../src/App.jsx";

describe("Welcome Message checklist", () => {
  it("The page heading says 'Welcome to React Labs'", () => {
    render(
      <StrictMode>
        <App />
      </StrictMode>
    );

    expect(
      screen.getByRole("heading", { name: "Welcome to React Labs" })
    ).toBeInTheDocument();
  });
});
