import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useGameStore } from "../game/store";
import { emptySnapshot } from "../sim/snapshot";
import { MetroView } from "./MetroView";

beforeEach(() => {
  // Seed a snapshot carrying a live train and a train-tracker map-log entry, so the
  // legend and the event log both have real train content to render.
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
      mapLog: [
        {
          reading: {
            sensor: "train-tracker",
            reading: {
              ts: 180,
              train: "T1",
              line: "red",
              station: "mkt",
              event: "arr",
              track: "red:har-mkt",
            },
          },
          tick: 90,
          source: "actor",
          actorId: "T1",
        },
      ],
    },
  });
});

describe("MetroView", () => {
  it("lists a train row in the Actors legend", () => {
    render(<MetroView />);
    expect(screen.getByText("train")).toBeDefined();
  });

  it("lists a pin attacker row in the Actors legend", () => {
    render(<MetroView />);
    expect(screen.getByText("pin attacker")).toBeDefined();
  });

  it("renders a train-tracker reading as an event-log row", () => {
    render(<MetroView />);
    expect(screen.getByText(/T1 arrive \(red\)/)).toBeDefined();
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
