import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { RunController } from "../game/run-controller";
import { useGameStore } from "../game/store";
import { referenceSource } from "../sim/scenarios/kiosk-pin-attack/reference";
import { App } from "./App";

// The zustand store is a singleton shared across test files, so reset the fields
// this file reads before each test, or a leaked `sourceLocked` would hide the Run
// button. Mirrors the reset pattern in store.test.ts.
beforeEach(() => {
  useGameStore.setState({ source: referenceSource, sourceLocked: false });
});

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
    const heading = screen.getByRole("heading", { name: "Detection Express" });
    expect(heading.textContent).toBe("Detection Express");
    expect(screen.getByText("Throughput")).toBeDefined();
    expect(screen.getByText("Backlog")).toBeDefined();
    expect(screen.getByRole("button", { name: "Run" })).toBeDefined();
  });

  it("runs the controller on mount and disposes it on unmount", () => {
    const controller = stubController();
    const { unmount } = render(<App controller={controller} />);
    expect(controller.runs).toBe(1);
    unmount();
    expect(controller.disposes).toBe(1);
  });

  it("does not mount the local-IDE control without a dev HMR channel", () => {
    // The local-IDE client gates on a live `import.meta.hot` channel, which the test
    // environment lacks, so neither the "Edit in IDE" nor "Stop editing" control shows.
    render(<App controller={stubController()} />);
    expect(screen.queryByRole("button", { name: "Edit in IDE" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop editing" })).toBeNull();
  });
});
