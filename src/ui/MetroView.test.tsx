import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
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
    render(<MetroView />);
    expect(screen.getByText("Lines")).toBeDefined();
    expect(screen.getByText("Actors")).toBeDefined();
    expect(screen.getByText("Sensors")).toBeDefined();
  });

  it("renders the key markup exactly once (CSS repositions it, JS never duplicates it)", () => {
    render(<MetroView />);
    expect(screen.getAllByText("Lines")).toHaveLength(1);
  });

  it("lists a train row in the Actors key column", () => {
    render(<MetroView />);
    expect(screen.getByText("train")).toBeDefined();
  });

  it("lists a pin attacker row in the Actors key column", () => {
    render(<MetroView />);
    expect(screen.getByText("pin attacker")).toBeDefined();
  });

  it("renders no event log (retired: it duplicated the pipeline log and findings)", () => {
    render(<MetroView />);
    expect(screen.queryByText("Event log")).toBeNull();
  });

  it("renders no header, counts, or speed control (retired to the pipeline transport)", () => {
    render(<MetroView />);
    expect(screen.queryByText("LIVING METRO")).toBeNull();
    expect(screen.queryByRole("slider")).toBeNull();
    expect(screen.queryByRole("button", { name: /pause|play/i })).toBeNull();
  });
});

describe("MetroView simulation-ended overlay", () => {
  it("shows nothing while the run is running", () => {
    useGameStore.setState({ snapshot: { ...emptySnapshot(), status: "running" } });
    render(<MetroView />);
    expect(screen.queryByRole("status", { name: /simulation ended/i })).toBeNull();
  });

  it("shows a won outcome once the run concludes", () => {
    useGameStore.setState({ snapshot: { ...emptySnapshot(), status: "won" } });
    render(<MetroView />);
    expect(screen.getByText(/simulation ended.*won/i)).toBeDefined();
  });

  it("shows the failure reason once the run fails on the queue", () => {
    useGameStore.setState({
      snapshot: { ...emptySnapshot(), status: "failed", failureReason: "queue" },
    });
    render(<MetroView />);
    expect(screen.getByText(/queue overflowed/i)).toBeDefined();
  });

  it("shows the failure reason once the run fails on correctness", () => {
    useGameStore.setState({
      snapshot: { ...emptySnapshot(), status: "failed", failureReason: "correctness" },
    });
    render(<MetroView />);
    expect(screen.getByText(/correctness too low/i)).toBeDefined();
  });
});
