import { describe, expect, it } from "vitest";
import { type AssertThresholdInWindowInput, assertThresholdInWindow } from "./separability";

/** One test record: an entity, a time, and whether it qualifies. */
interface Rec {
  entity: string;
  ts: number;
  fail: boolean;
}

/** The fixed shape every case shares: threshold 3 inside a 10-unit window. */
function input(
  records: Rec[],
  attackWindow?: { startTs: number; endTs: number },
): AssertThresholdInWindowInput<Rec> {
  return {
    records,
    threshold: 3,
    window: 10,
    keyOf: (r) => r.entity,
    tsOf: (r) => r.ts,
    qualifies: (r) => r.fail,
    attackWindowOf: () => attackWindow,
  };
}

describe("assertThresholdInWindow", () => {
  it("passes a burst that crosses the threshold fully inside its own Attack window", () => {
    const records: Rec[] = [
      { entity: "a", ts: 0, fail: true },
      { entity: "a", ts: 2, fail: true },
      { entity: "a", ts: 4, fail: true },
    ];
    expect(() => assertThresholdInWindow(input(records, { startTs: 0, endTs: 4 }))).not.toThrow();
  });

  it("passes benign traffic that never reaches the threshold inside any window", () => {
    const records: Rec[] = [
      { entity: "b", ts: 0, fail: true },
      { entity: "b", ts: 20, fail: true },
    ];
    expect(() => assertThresholdInWindow(input(records))).not.toThrow();
  });

  it("throws on a planted stray crossing with no owning Attack", () => {
    const records: Rec[] = [
      { entity: "c", ts: 0, fail: true },
      { entity: "c", ts: 2, fail: true },
      { entity: "c", ts: 4, fail: true },
    ];
    expect(() => assertThresholdInWindow(input(records))).toThrow(/crosses the threshold/);
  });

  it("throws when the crossing only partially overlaps its Attack window", () => {
    const records: Rec[] = [
      { entity: "d", ts: 0, fail: true },
      { entity: "d", ts: 2, fail: true },
      { entity: "d", ts: 4, fail: true },
    ];
    expect(() => assertThresholdInWindow(input(records, { startTs: 0, endTs: 2 }))).toThrow(
      /crosses the threshold/,
    );
  });

  it("ignores records that do not qualify", () => {
    const records: Rec[] = [
      { entity: "e", ts: 0, fail: false },
      { entity: "e", ts: 2, fail: false },
      { entity: "e", ts: 4, fail: false },
    ];
    expect(() => assertThresholdInWindow(input(records))).not.toThrow();
  });

  it("does not require pre-sorted input", () => {
    const records: Rec[] = [
      { entity: "f", ts: 4, fail: true },
      { entity: "f", ts: 0, fail: true },
      { entity: "f", ts: 2, fail: true },
    ];
    expect(() => assertThresholdInWindow(input(records, { startTs: 0, endTs: 4 }))).not.toThrow();
  });

  it("keeps one key's crossing from tripping another key's check", () => {
    const records: Rec[] = [
      { entity: "victim", ts: 0, fail: true },
      { entity: "victim", ts: 2, fail: true },
      { entity: "victim", ts: 4, fail: true },
      { entity: "bystander", ts: 0, fail: true },
      { entity: "bystander", ts: 20, fail: true },
    ];
    expect(() => assertThresholdInWindow(input(records, { startTs: 0, endTs: 4 }))).not.toThrow();
  });
});
