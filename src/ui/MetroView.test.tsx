import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useGameStore } from "../game/store";
import { emptySnapshot } from "../sim/snapshot";
import { MetroView } from "./MetroView";

beforeEach(() => {
  // Seed a snapshot carrying a live train, so the Actors key column has real train
  // content to render.
  useGameStore.setState({
    snapshot: {
      ...emptySnapshot(),
      nowTick: 90,
      actors: [
        {
          id: "T1",
          kind: "train",
          presence: {
            kind: "moving",
            from: "har",
            to: "mkt",
            line: "red",
            fromTick: 0,
            untilTick: 90,
          },
        },
      ],
    },
  });
});

describe("MetroView", () => {
  it("renders the Lines, Actors, and Sensors key sections", () => {
    render(<MetroView onSelect={() => {}} />);
    expect(screen.getByText("Lines")).toBeDefined();
    expect(screen.getByText("Actors")).toBeDefined();
    expect(screen.getByText("Sensors")).toBeDefined();
  });

  it("renders the key markup exactly once (CSS repositions it, JS never duplicates it)", () => {
    render(<MetroView onSelect={() => {}} />);
    expect(screen.getAllByText("Lines")).toHaveLength(1);
  });

  it("lists a train row in the Actors key column", () => {
    render(<MetroView onSelect={() => {}} />);
    expect(screen.getByText("train")).toBeDefined();
  });

  it("renders one lucide icon per sensor kind in the legend, not a bare colored square", () => {
    const { container } = render(<MetroView onSelect={() => {}} />);
    const icons = container.querySelectorAll(".metro-chip-swatch svg.lucide");
    expect(icons).toHaveLength(9);
    // Spot-check one mapping: the kiosk row draws the Monitor icon.
    expect(container.querySelector(".metro-chip-swatch svg.lucide-monitor")).not.toBeNull();
  });

  it("lists a pin attacker row in the Actors key column", () => {
    render(<MetroView onSelect={() => {}} />);
    expect(screen.getByText("pin attacker")).toBeDefined();
  });

  it("names sensors in the Sensors key from the unified sensor-catalogue, not a stale local table", () => {
    render(<MetroView onSelect={() => {}} />);
    // Unified names (sensor-catalogue / sensors.data.ts), each with its curated
    // zone-range annotation kept intact.
    expect(screen.getByText("Ticket vending machine (Z0)")).toBeDefined();
    expect(screen.getByText("Control console (Z4)")).toBeDefined();
    expect(screen.getByText("Door contact sensor (Z1-Z4)")).toBeDefined();
    // The old, pre-M2 names this legend used to show on its own must be gone.
    expect(screen.queryByText("ticket machine (Z0)")).toBeNull();
    expect(screen.queryByText("control console (Z4)")).toBeNull();
    expect(screen.queryByText("door contact (Z1-Z4)")).toBeNull();
  });

  it("renders no event log (retired: it duplicated the pipeline log and findings)", () => {
    render(<MetroView onSelect={() => {}} />);
    expect(screen.queryByText("Event log")).toBeNull();
  });

  it("renders no header, counts, or speed control (retired to the pipeline transport)", () => {
    render(<MetroView onSelect={() => {}} />);
    expect(screen.queryByText("LIVING METRO")).toBeNull();
    expect(screen.queryByRole("slider")).toBeNull();
    expect(screen.queryByRole("button", { name: /pause|play/i })).toBeNull();
  });
});

describe("MetroView mobile legend chip (GH133-PLAN.md)", () => {
  it("renders a Show legend button and calls onOpenLegend on click", () => {
    const onOpenLegend = vi.fn();
    render(<MetroView onSelect={() => {}} onOpenLegend={onOpenLegend} />);
    fireEvent.click(screen.getByRole("button", { name: "Show legend" }));
    expect(onOpenLegend).toHaveBeenCalledTimes(1);
  });
});

describe("MetroView wave outcome banner (GH126-PLAN.md M3b, replaces the retired won/lost end screen)", () => {
  it("shows nothing while no wave outcome is fresh", () => {
    useGameStore.setState({ snapshot: { ...emptySnapshot(), waveOutcome: null } });
    render(<MetroView onSelect={() => {}} />);
    expect(screen.queryByRole("status", { name: /threat contained|breach/i })).toBeNull();
  });

  it("shows a held wave outcome with the caught-of-total count", () => {
    useGameStore.setState({
      snapshot: {
        ...emptySnapshot(),
        waveOutcome: {
          waveId: 1,
          outcome: "held",
          attackCount: 5,
          caughtCount: 5,
          allCaught: true,
          queuePeak: 3,
        },
      },
    });
    render(<MetroView onSelect={() => {}} />);
    expect(screen.getByText(/threat contained/i)).toBeDefined();
    expect(screen.getByText(/5\/5/)).toBeDefined();
  });

  it("renders no won/lost end screen (retired: the endless baseline never reaches won or lost)", () => {
    useGameStore.setState({ snapshot: { ...emptySnapshot(), status: "won" } });
    render(<MetroView onSelect={() => {}} />);
    expect(screen.queryByText(/simulation ended/i)).toBeNull();
  });
});
