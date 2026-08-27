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
});
