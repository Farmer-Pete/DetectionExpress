import { describe, expect, it } from "vitest";
import { composeRun } from "./compose";

interface Reading {
  seq: number;
  ts: number;
  value: string;
}

const readings: Reading[] = [
  { seq: 0, ts: 10, value: "c" },
  { seq: 1, ts: 4, value: "a" },
  { seq: 2, ts: 10, value: "b" }, // ties reading[0] on ts; emission order breaks the tie
  { seq: 3, ts: 7, value: "d" },
];

function compose() {
  return composeRun({
    readings,
    tsOf: (r: Reading) => r.ts,
    format: (r: Reading) => ({ value: r.value }),
    endpointId: "test-endpoint-v1",
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

  it("stamps every event with the given endpointId", () => {
    const { events } = compose();
    for (const event of events) {
      expect(event.endpoint).toBe("test-endpoint-v1");
    }
  });

  it("returns an empty attacks array", () => {
    const { attacks } = compose();
    expect(attacks).toEqual([]);
  });

  it("handles an empty reading list", () => {
    const result = composeRun({
      readings: [],
      tsOf: () => 0,
      format: () => ({}),
      endpointId: "empty",
    });
    expect(result.events).toEqual([]);
    expect(result.attacks).toEqual([]);
  });

  it("does not mutate the input readings array", () => {
    const before = [...readings];
    compose();
    expect(readings).toEqual(before);
  });
});
