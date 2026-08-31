import { describe, expect, it } from "vitest";
import { composeRun } from "./compose";

interface Reading {
  seq: number;
  ts: number;
  value: string;
  /** Ground-truth attack id, or null for a benign reading. */
  attack: number | null;
}

const readings: Reading[] = [
  { seq: 0, ts: 10, value: "c", attack: 7 },
  { seq: 1, ts: 4, value: "a", attack: 7 },
  { seq: 2, ts: 10, value: "b", attack: null }, // ties reading[0] on ts; emission order breaks the tie
  { seq: 3, ts: 7, value: "d", attack: 3 },
];

function compose() {
  return composeRun({
    readings,
    tsOf: (r: Reading) => r.ts,
    format: (r: Reading) => ({ value: r.value }),
    endpointIdOf: () => "test-endpoint-v1",
    attackIdOf: (r: Reading) => r.attack,
  });
}

describe("composeRun", () => {
  it("sorts by (ts, emission order)", () => {
    const { events } = compose();
    expect(events.map((e) => e.payload)).toEqual([
      { value: "a" },
      { value: "d" },
      { value: "c" }, // seq 0 comes before seq 2 at the tied ts 10
      { value: "b" },
    ]);
  });

  it("assigns ids 0..n-1 in sorted order", () => {
    const { events } = compose();
    events.forEach((event, index) => {
      expect(event.id).toBe(index);
    });
  });

  it("carries each event's ts from tsOf", () => {
    const { events } = compose();
    expect(events.map((e) => e.ts)).toEqual([4, 7, 10, 10]);
  });

  it("stamps every event with the endpoint id from endpointIdOf, per reading", () => {
    // Per-reading endpoint: prove the stamp is read per event, not once.
    const { events } = composeRun({
      readings,
      tsOf: (r: Reading) => r.ts,
      format: (r: Reading) => ({ value: r.value }),
      endpointIdOf: (r: Reading) => `endpoint-${r.value}`,
    });
    // Sorted order is a, d, c, b.
    expect(events.map((e) => e.endpoint)).toEqual([
      "endpoint-a",
      "endpoint-d",
      "endpoint-c",
      "endpoint-b",
    ]);
  });

  it("buckets post-sort event ids per attack id, ids ascending", () => {
    const { eventIdsByAttack } = compose();
    // Sorted: a(id0,attack7), d(id1,attack3), c(id2,attack7), b(id3,benign).
    expect(eventIdsByAttack.get(7)).toEqual([0, 2]);
    expect(eventIdsByAttack.get(3)).toEqual([1]);
    expect(eventIdsByAttack.has(3)).toBe(true);
    // A benign reading contributes to no bucket.
    expect([...eventIdsByAttack.keys()].sort((a, b) => a - b)).toEqual([3, 7]);
  });

  it("returns an empty attack map when attackIdOf is omitted", () => {
    const { eventIdsByAttack } = composeRun({
      readings,
      tsOf: (r: Reading) => r.ts,
      format: (r: Reading) => ({ value: r.value }),
      endpointIdOf: () => "test-endpoint-v1",
    });
    expect(eventIdsByAttack.size).toBe(0);
  });

  it("handles an empty reading list", () => {
    const result = composeRun({
      readings: [],
      tsOf: () => 0,
      format: () => ({}),
      endpointIdOf: () => "empty",
    });
    expect(result.events).toEqual([]);
    expect(result.eventIdsByAttack.size).toBe(0);
  });

  it("does not mutate the input readings array", () => {
    const before = [...readings];
    compose();
    expect(readings).toEqual(before);
  });
});
