import { StrictMode } from "react";
import { render, screen } from "../test-utils/custom-render.jsx";
import { describe, expect, it } from "vitest";
import App from "../src/App.jsx";

describe("Empty State checklist", () => {
  it("Shows an empty state when there are no tasks", () => {
    render(
      <StrictMode>
        <App />
      </StrictMode>
    );

    expect(
      screen.getByText("No tasks yet. Add your first task to get started.")
    ).toBeInTheDocument();
  });
});
