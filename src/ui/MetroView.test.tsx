import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useWorldStore } from "../game/world-store";
import { emptyWorldSnapshot } from "../sim/world-snapshot";
import { MetroView } from "./MetroView";

beforeEach(() => {
  // Seed a snapshot carrying a live train and a train-tracker log entry, so the legend
  // and the event log both have real train content to render.
  useWorldStore.setState({
    worldSnapshot: {
      ...emptyWorldSnapshot(),
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
      log: [
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
      counts: { riders: 0, trains: 1, staff: 0 },
    },
  });
});

describe("MetroView", () => {
  it("lists a train row in the Actors legend", () => {
    render(<MetroView />);
    expect(screen.getByText("train")).toBeDefined();
  });

  it("renders a train-tracker reading as an event-log row", () => {
    render(<MetroView />);
    expect(screen.getByText(/T1 arrive \(red\)/)).toBeDefined();
  });
});
