import { beforeEach, describe, expect, it } from "bun:test";
import { render, screen } from "@testing-library/react";
import { useGameStore } from "../../game/store";
import { emptySnapshot } from "../../sim/snapshot";
import { Hud } from "./Hud";

beforeEach(() => {
  useGameStore.setState({ snapshot: emptySnapshot() });
});

describe("Hud", () => {
  it("renders the Correctness gauge with the rolling value from the store snapshot", () => {
    useGameStore.setState({
      snapshot: {
        ...emptySnapshot(),
        correctness: { rolling: 78, caught: 5, missed: 2, falseAlerts: 1 },
      },
    });
    render(<Hud />);
    expect(screen.getByText("Correctness")).toBeDefined();
    expect(screen.getByText("78")).toBeDefined();
  });

  it("renders the caught, missed, and false-alert counts", () => {
    useGameStore.setState({
      snapshot: {
        ...emptySnapshot(),
        correctness: { rolling: 78, caught: 5, missed: 2, falseAlerts: 1 },
      },
    });
    render(<Hud />);
    expect(screen.getByText("5 caught")).toBeDefined();
    expect(screen.getByText("2 missed")).toBeDefined();
    expect(screen.getByText("1 false")).toBeDefined();
  });

  it("renders the Compute gauge with the per-rule cost from the snapshot", () => {
    useGameStore.setState({
      snapshot: { ...emptySnapshot(), compute: 0.05 },
    });
    render(<Hud />);
    expect(screen.getByText("Compute")).toBeDefined();
    expect(screen.getByText("0.05")).toBeDefined();
  });

  it("reads Running before any outcome", () => {
    render(<Hud />);
    expect(screen.getByText("Running")).toBeDefined();
  });

  it("shows the win outcome", () => {
    useGameStore.setState({
      snapshot: { ...emptySnapshot(), status: "won", failureReason: null },
    });
    render(<Hud />);
    expect(screen.getByText("Won")).toBeDefined();
  });

  it("shows the loss and its reason", () => {
    useGameStore.setState({
      snapshot: { ...emptySnapshot(), status: "failed", failureReason: "backlog" },
    });
    render(<Hud />);
    expect(screen.getByText("Failed: Backlog overflowed")).toBeDefined();
  });

  it("shows the correctness loss reason", () => {
    useGameStore.setState({
      snapshot: { ...emptySnapshot(), status: "failed", failureReason: "correctness" },
    });
    render(<Hud />);
    expect(screen.getByText("Failed: Correctness too low")).toBeDefined();
  });
});
