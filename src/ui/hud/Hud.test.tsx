import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
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

  it("reads the authoritative queue (admitted - completed), not the channel sum", () => {
    // On a terminal queue loss the channels can read empty while one Event is
    // still in service; admitted - completed keeps it visible (GH3-PLAN.md 5.5).
    useGameStore.setState({
      snapshot: {
        ...emptySnapshot(),
        status: "failed",
        failureReason: "queue",
        queued: 0,
        admitted: 40,
        completed: 25,
      },
    });
    render(<Hud />);
    expect(screen.getByText("15")).toBeDefined(); // 40 - 25, not the channel-sum 0
  });
});

describe("Hud gauge descriptions (GH124)", () => {
  it("renders a short explanatory caption under each of the four gauges", () => {
    render(<Hud />);
    expect(screen.getByText("Events the Engine finishes per second.")).toBeDefined();
    expect(
      screen.getByText("Events admitted but not yet processed. A growing Queue fails the run."),
    ).toBeDefined();
    expect(screen.getByText("Ticks each Event costs your Rules. Lower is cheaper.")).toBeDefined();
    expect(
      screen.getByText("Rolling accuracy from caught, missed, and false Alerts."),
    ).toBeDefined();
  });
});

/** Find one gauge's fill element by its label text (Hud renders several `.gauge-fill`s). */
function gaugeFill(label: string): Element {
  const gauge = screen.getByText(label).closest(".gauge");
  if (!gauge) {
    throw new Error(`expected a .gauge ancestor for label "${label}"`);
  }
  const fill = gauge.querySelector(".gauge-fill");
  if (!fill) {
    throw new Error(`expected a .gauge-fill inside the "${label}" gauge`);
  }
  return fill;
}

describe("Hud gauge pulse routing (#38 juice item 2)", () => {
  it("pulses the Queue gauge at danger severity", () => {
    // QUEUE_MAX is 2 * CHANNEL_CAP (200); 160/200 = 0.8 = SEVERITY_DANGER_FRAC.
    useGameStore.setState({
      snapshot: { ...emptySnapshot(), admitted: 200, completed: 40 },
    });
    render(<Hud />);
    expect(gaugeFill("Queue").className).toMatch(/gauge-fill-pulse/);
  });

  it("does not pulse the Queue gauge below danger severity", () => {
    // 50/200 = 0.25: well under SEVERITY_DANGER_FRAC.
    useGameStore.setState({
      snapshot: { ...emptySnapshot(), admitted: 50, completed: 0 },
    });
    render(<Hud />);
    expect(gaugeFill("Queue").className).not.toMatch(/gauge-fill-pulse/);
  });

  it("never pulses the Compute gauge, even at danger severity", () => {
    // COMPUTE_MAX is 2 / OMEGA (0.1); 0.09/0.1 = 0.9, well past SEVERITY_DANGER_FRAC.
    useGameStore.setState({
      snapshot: { ...emptySnapshot(), compute: 0.09 },
    });
    render(<Hud />);
    expect(gaugeFill("Compute").className).not.toMatch(/gauge-fill-pulse/);
  });
});

describe("Hud gauge pulse gates on run conclusion (GH38 review round 3, F004+F006)", () => {
  it("omits the Queue pulse at danger severity once the run has failed", () => {
    useGameStore.setState({
      snapshot: { ...emptySnapshot(), admitted: 200, completed: 40, status: "failed" },
    });
    render(<Hud />);
    expect(gaugeFill("Queue").className).not.toMatch(/gauge-fill-pulse/);
  });

  it("keeps the Queue pulse at danger severity while the run is running", () => {
    useGameStore.setState({
      snapshot: { ...emptySnapshot(), admitted: 200, completed: 40, status: "running" },
    });
    render(<Hud />);
    expect(gaugeFill("Queue").className).toMatch(/gauge-fill-pulse/);
  });
});
