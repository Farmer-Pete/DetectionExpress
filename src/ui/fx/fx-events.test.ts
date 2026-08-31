import { describe, expect, it } from "vitest";
import type { Decision, LiveFinding, MissedDecision } from "../../sim/correctness";
import type { Finding } from "../../sim/finding";
import { diffDecisions, diffFindings } from "./fx-events";

/** A minimal LiveFinding fixture; only `seq` and `state` matter to the diff. */
function finding(seq: number, state: "hit" | "watch", reason = "pin_brute_force"): LiveFinding {
  const alert: Finding["alert"] = { reason, at: 0, eventIds: [seq] };
  return { finding: { alert, eventId: seq }, state, reason, eventIds: [seq], at: 0, seq };
}

function missed(seq: number): MissedDecision {
  return {
    outcome: "missed",
    seq,
    at: 0,
    attackId: seq,
    entity: `entity-${seq}`,
    reason: "pin_brute_force",
    window: { startTs: 0, endTs: 0 },
  };
}

describe("diffFindings", () => {
  it("fires on a brand-new hit not seen in prev", () => {
    const landed = diffFindings([], [finding(1, "hit")], new Set());
    expect(landed.map((f) => f.seq)).toEqual([1]);
  });

  it("fires on a watch promoting to a hit", () => {
    const prev = [finding(1, "watch")];
    const next = [finding(1, "hit")];
    const landed = diffFindings(prev, next, new Set());
    expect(landed.map((f) => f.seq)).toEqual([1]);
  });

  it("does not fire on a brand-new watch", () => {
    const landed = diffFindings([], [finding(1, "watch")], new Set());
    expect(landed).toEqual([]);
  });

  it("does not fire on a hit -> hit re-emit with grown eventIds", () => {
    const prev = [finding(1, "hit")];
    const grown: LiveFinding = { ...finding(1, "hit"), eventIds: [1, 2, 3] };
    const landed = diffFindings(prev, [grown], new Set());
    expect(landed).toEqual([]);
  });

  it("does not fire on hit -> watch -> hit for a seq already recorded as fired", () => {
    // The seq already landed once (tracked externally in firedSeqs); a later demotion
    // to watch and re-promotion to hit must not refire it.
    const prev = [finding(1, "watch")];
    const next = [finding(1, "hit")];
    const landed = diffFindings(prev, next, new Set([1]));
    expect(landed).toEqual([]);
  });

  it("fires independently for each of several new hits in one burst delta", () => {
    const landed = diffFindings([], [finding(1, "hit"), finding(2, "hit")], new Set());
    expect(landed.map((f) => f.seq).sort()).toEqual([1, 2]);
  });

  it("survives a simulated run reset: fresh empty prev and firedSeqs treat a reused seq as new", () => {
    // A run restart resets the scorer's seq counter to zero and the caller resets its
    // own prev/firedSeqs bookkeeping; diffFindings itself needs no reset logic since
    // it is pure and stateless per call.
    const landed = diffFindings([], [finding(0, "hit")], new Set());
    expect(landed.map((f) => f.seq)).toEqual([0]);
  });
});

describe("diffDecisions", () => {
  it("returns nothing when the log has not grown", () => {
    const log: Decision[] = [missed(0)];
    expect(diffDecisions(1, log)).toEqual([]);
  });

  it("returns only the decisions appended since prevLength", () => {
    const log: Decision[] = [missed(0), missed(1), missed(2)];
    expect(diffDecisions(1, log).map((d) => d.seq)).toEqual([1, 2]);
  });

  it("returns the whole log from a zero prevLength", () => {
    const log: Decision[] = [missed(0), missed(1)];
    expect(diffDecisions(0, log).map((d) => d.seq)).toEqual([0, 1]);
  });

  it("survives a simulated run reset: a fresh short log from prevLength 0 reads as all new", () => {
    const freshLog: Decision[] = [missed(0)];
    expect(diffDecisions(0, freshLog)).toEqual(freshLog);
  });
});
