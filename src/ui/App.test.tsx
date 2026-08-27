import { describe, expect, it } from "bun:test";
import { render, screen } from "@testing-library/react";
import type { RunController } from "../game/run-controller";
import { App } from "./App";

/** A no-op controller so the test never touches the real loader or engine. */
function stubController(): RunController & { runs: number; disposes: number } {
  let runs = 0;
  let disposes = 0;
  return {
    get runs() {
      return runs;
    },
    get disposes() {
      return disposes;
    },
    run() {
      runs += 1;
    },
    dispose() {
      disposes += 1;
    },
  };
}

describe("App", () => {
  it("renders the heading, both gauges, and the Algorithm editor", () => {
    render(<App controller={stubController()} />);
    // getByRole/getByText throw if missing, so finding them is the assertion.
    const heading = screen.getByRole("heading", { name: "Detection Dash" });
    expect(heading.textContent).toBe("Detection Dash");
    expect(screen.getByText("Throughput")).toBeDefined();
    expect(screen.getByText("Backlog")).toBeDefined();
    expect(screen.getByRole("button", { name: "Run" })).toBeDefined();
  });

  it("runs the controller on mount", () => {
    const controller = stubController();
    render(<App controller={controller} />);
    expect(controller.runs).toBe(1);
  });
});
