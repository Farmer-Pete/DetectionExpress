import { describe, expect, it } from "vitest";
import type {
  CaughtDecision,
  Decision,
  FalseDecision,
  MissedDecision,
} from "../../sim/correctness";
import { buildDecisionRows, outcomeLabel } from "./view-model";

/** A caught decision. `at` is a fabricated decoy; the row must read `resolvedAt`. */
function caught(over: { seq: number; resolvedAt: number; entity?: string }): CaughtDecision {
  return {
    outcome: "caught",
    seq: over.seq,
    at: 999,
    resolvedAt: over.resolvedAt,
    attackId: 1,
    entity: over.entity ?? "acct-7",
    finding: {
      alert: { reason: "pin_brute_force", at: 999, eventIds: [0] },
      eventId: 0,
    },
    citedEvents: [],
  };
}

/** A false decision, optionally with no resolved entity. */
function falseDecision(over: { seq: number; resolvedAt: number; entity?: string }): FalseDecision {
  const decision: FalseDecision = {
    outcome: "false",
    seq: over.seq,
    at: 999,
    resolvedAt: over.resolvedAt,
    finding: {
      alert: { reason: "impossible_travel", at: 999, eventIds: [0] },
      eventId: 0,
    },
    citedEvents: [],
  };
  if (over.entity !== undefined) {
    decision.entity = over.entity;
  }
  return decision;
}

/** A missed decision. */
function missed(over: { seq: number; resolvedAt: number }): MissedDecision {
  return {
    outcome: "missed",
    seq: over.seq,
    at: over.resolvedAt,
    resolvedAt: over.resolvedAt,
    attackId: 1,
    entity: "acct-9",
    reason: "pin_brute_force",
    window: { startTs: 0, endTs: over.resolvedAt },
  };
}

describe("buildDecisionRows", () => {
  it("orders rows newest-first, reversing the seq-ascending log", () => {
    const decisions: Decision[] = [
      caught({ seq: 0, resolvedAt: 10 }),
      falseDecision({ seq: 1, resolvedAt: 20 }),
      missed({ seq: 2, resolvedAt: 30 }),
    ];
    const rows = buildDecisionRows(decisions);
    expect(rows.map((r) => r.seq)).toEqual([2, 1, 0]);
  });

  it("maps a caught decision's outcome, entity, reason, and time", () => {
    const rows = buildDecisionRows([caught({ seq: 0, resolvedAt: 42, entity: "acct-7" })]);
    expect(rows[0]).toMatchObject({
      seq: 0,
      outcome: "caught",
      entity: "acct-7",
      reason: "Pin brute force",
      time: 42,
    });
  });

  it("maps a false decision, with entity null when the finding named no subject", () => {
    const rows = buildDecisionRows([falseDecision({ seq: 0, resolvedAt: 15 })]);
    expect(rows[0]).toMatchObject({
      outcome: "false",
      entity: null,
      reason: "Impossible travel",
      time: 15,
    });
  });

  it("maps a false decision's resolved entity when it has one", () => {
    const rows = buildDecisionRows([falseDecision({ seq: 0, resolvedAt: 15, entity: "ghost" })]);
    expect(rows[0]?.entity).toBe("ghost");
  });

  it("maps a missed decision's outcome, entity, reason, and time", () => {
    const rows = buildDecisionRows([missed({ seq: 0, resolvedAt: 100 })]);
    expect(rows[0]).toMatchObject({
      outcome: "missed",
      entity: "acct-9",
      reason: "Pin brute force",
      time: 100,
    });
  });

  it("reads the row time from resolvedAt, diverging from a fabricated at", () => {
    // caught()/falseDecision() fix `at` to 999; resolvedAt is the real, trusted time.
    const rows = buildDecisionRows([caught({ seq: 0, resolvedAt: 7 })]);
    expect(rows[0]?.time).toBe(7);
    expect(rows[0]?.time).not.toBe(999);
  });

  it("returns an empty array for an empty log", () => {
    expect(buildDecisionRows([])).toEqual([]);
  });
});

describe("outcomeLabel", () => {
  it("labels each outcome with player-facing copy, not the raw token", () => {
    expect(outcomeLabel("caught")).toBe("Caught");
    expect(outcomeLabel("missed")).toBe("Missed");
    expect(outcomeLabel("false")).toBe("False alert");
  });
});
