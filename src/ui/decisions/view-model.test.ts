import { describe, expect, it } from "vitest";
import type { Decision } from "../../sim/correctness";
import { caughtDecision, falseDecision, missedDecision } from "./decision-fixtures";
import { buildDecisionRows, outcomeLabel } from "./view-model";

describe("buildDecisionRows", () => {
  it("orders rows newest-first, reversing the seq-ascending log", () => {
    const decisions: Decision[] = [
      caughtDecision({ seq: 0, resolvedAt: 10 }),
      falseDecision({ seq: 1, resolvedAt: 20 }),
      missedDecision({ seq: 2, resolvedAt: 30 }),
    ];
    const rows = buildDecisionRows(decisions);
    expect(rows.map((r) => r.seq)).toEqual([2, 1, 0]);
  });

  it("maps a caught decision's outcome, entity, reason, and time", () => {
    const rows = buildDecisionRows([caughtDecision({ seq: 0, resolvedAt: 42, entity: "acct-7" })]);
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
    const rows = buildDecisionRows([missedDecision({ seq: 0, resolvedAt: 100 })]);
    expect(rows[0]).toMatchObject({
      outcome: "missed",
      entity: "acct-9",
      reason: "Pin brute force",
      time: 100,
    });
  });

  it("reads the row time from resolvedAt, diverging from a fabricated at", () => {
    // caughtDecision()/falseDecision() fix `at` to 999; resolvedAt is the real, trusted time.
    const rows = buildDecisionRows([caughtDecision({ seq: 0, resolvedAt: 7 })]);
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
