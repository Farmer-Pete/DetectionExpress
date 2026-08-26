import { describe, expect, it } from "bun:test";
import { render, screen } from "@testing-library/react";
import { App } from "./App";

describe("App", () => {
  it("renders the title", () => {
    render(<App />);
    // getByRole throws if the heading is missing, so finding it is the assertion.
    const heading = screen.getByRole("heading", { name: "Detection Dash" });
    expect(heading.textContent).toBe("Detection Dash");
  });
});
