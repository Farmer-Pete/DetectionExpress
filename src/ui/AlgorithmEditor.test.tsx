import { beforeEach, describe, expect, it } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { useGameStore } from "../game/store";
import { optimizationSource } from "../sim/scenarios/kiosk-pin-attack/optimization";
import { referenceSource } from "../sim/scenarios/kiosk-pin-attack/reference";
import { AlgorithmEditor } from "./AlgorithmEditor";

/**
 * The editor ships the naive default and offers the Optimization as a one-click
 * apply, so the player moves from the naive scan to the incremental tally with a
 * small edit (GH3-PLAN.md section 13, M3).
 */
describe("AlgorithmEditor", () => {
  beforeEach(() => {
    useGameStore.getState().setAlgorithmSource(referenceSource);
  });

  it("starts on the naive default source", () => {
    expect(useGameStore.getState().source).toBe(referenceSource);
  });

  it("swaps the source to the Optimization when Apply Optimization is clicked", () => {
    render(<AlgorithmEditor onRun={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: /apply optimization/i }));
    expect(useGameStore.getState().source).toBe(optimizationSource);
  });

  it("runs the current source when Run is clicked", () => {
    let ran = 0;
    render(<AlgorithmEditor onRun={() => (ran += 1)} />);
    fireEvent.click(screen.getByRole("button", { name: /^run$/i }));
    expect(ran).toBe(1);
  });
});
