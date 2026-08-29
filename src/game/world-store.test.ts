import { beforeEach, describe, expect, it } from "vitest";
import { emptyWorldSnapshot, type WorldSnapshot } from "../sim/world-snapshot";
import { useWorldStore } from "./world-store";

beforeEach(() => {
  useWorldStore.setState({ worldSnapshot: emptyWorldSnapshot() });
});

describe("world store", () => {
  it("seeds an empty world snapshot", () => {
    expect(useWorldStore.getState().worldSnapshot).toEqual(emptyWorldSnapshot());
  });

  it("stores a published world snapshot through setWorldSnapshot", () => {
    const snapshot: WorldSnapshot = {
      nowTick: 12,
      actors: [
        {
          id: "C1",
          kind: "rider",
          presence: { kind: "at", node: "cen", fromTick: 0, untilTick: 4 },
        },
      ],
      doors: [{ node: "depot::vault", open: true }],
      crowds: [{ node: "cen", persons: 3, grants: 3 }],
      flashes: [{ id: 0, kind: "tap", node: "cen", atTick: 10 }],
      counts: { riders: 1, trains: 0, staff: 0 },
    };
    useWorldStore.getState().setWorldSnapshot(snapshot);
    expect(useWorldStore.getState().worldSnapshot).toEqual(snapshot);
  });
});
