import { StrictMode } from "react";
import { render, screen } from "../test-utils/custom-render.jsx";
import { describe, expect, it } from "vitest";
import App from "../src/App.jsx";

describe("Button Label checklist", () => {
  it("The primary action button says 'Join Newsletter'", () => {
    render(
      <StrictMode>
        <App />
      </StrictMode>
    );

    expect(
      screen.getByRole("button", { name: "Join Newsletter" })
    ).toBeInTheDocument();
  });
});
