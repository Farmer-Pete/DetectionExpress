import { describe, expect, it } from "bun:test";
import { render, screen } from "@testing-library/react";
import { App } from "./App";

describe("App", () => {
  it("renders the heading and both gauges", () => {
    render(<App />);
    // getByRole/getByText throw if missing, so finding them is the assertion.
    const heading = screen.getByRole("heading", { name: "Detection Dash" });
    expect(heading.textContent).toBe("Detection Dash");
    expect(screen.getByText("Throughput")).toBeDefined();
    expect(screen.getByText("Backlog")).toBeDefined();
  });
});
