import { describe, expect, it } from "vitest";
import { emptyWorldSnapshot } from "./world-snapshot";

describe("emptyWorldSnapshot", () => {
  it("is an empty, quiet world at tick 0", () => {
    const snapshot = emptyWorldSnapshot();
    expect(snapshot.nowTick).toBe(0);
    expect(snapshot.actors).toEqual([]);
    expect(snapshot.doors).toEqual([]);
    expect(snapshot.crowds).toEqual([]);
    expect(snapshot.flashes).toEqual([]);
    expect(snapshot.counts).toEqual({ riders: 0, trains: 0, staff: 0 });
  });

  it("returns a fresh object each call, so a mutation cannot leak between runs", () => {
    expect(emptyWorldSnapshot()).not.toBe(emptyWorldSnapshot());
  });
});
