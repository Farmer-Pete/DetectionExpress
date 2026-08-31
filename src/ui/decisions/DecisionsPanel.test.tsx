import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useGameStore } from "../../game/store";
import type {
  CaughtDecision,
  Decision,
  FalseDecision,
  MissedDecision,
} from "../../sim/correctness";
import { emptySnapshot, type SimSnapshot } from "../../sim/snapshot";
import { DecisionsPanel } from "./DecisionsPanel";

// The zustand store is a singleton shared across test files, so reset the fields this
// file reads before each test, mirroring the reset pattern in FindingsPanel.test.tsx.
beforeEach(() => {
  useGameStore.setState({ snapshot: emptySnapshot(), decisionSelection: null, selection: null });
});

/** A caught decision. `at` is a fabricated decoy; the row must read `resolvedAt`. */
function caught(over: { seq: number; resolvedAt: number; entity?: string }): CaughtDecision {
  return {
    outcome: "caught",
    seq: over.seq,
    at: 999,
    resolvedAt: over.resolvedAt,
    attackId: 1,
    entity: over.entity ?? "acct-7",
    finding: { alert: { reason: "pin_brute_force", at: 999, eventIds: [0] }, eventId: 0 },
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
    finding: { alert: { reason: "impossible_travel", at: 999, eventIds: [0] }, eventId: 0 },
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

/** Publish a snapshot carrying the given decisions. */
function publish(decisions: Decision[]): void {
  const snapshot: SimSnapshot = { ...emptySnapshot(), decisions };
  useGameStore.setState({ snapshot });
}

describe("DecisionsPanel", () => {
  it("shows the empty state when there are no decisions", () => {
    publish([]);
    render(<DecisionsPanel />);
    expect(screen.getByText(/no decisions yet/i)).toBeDefined();
  });

  it("renders rows newest-first, each with outcome, entity, reason, and time", () => {
    publish([
      caught({ seq: 0, resolvedAt: 10, entity: "acct-7" }),
      falseDecision({ seq: 1, resolvedAt: 20, entity: "ghost" }),
      missed({ seq: 2, resolvedAt: 30 }),
    ]);
    render(<DecisionsPanel />);
    const rows = screen.getAllByRole("button");
    expect(rows).toHaveLength(3);
    // Newest first: seq 2 (missed), then 1 (false), then 0 (caught).
    expect(rows[0]?.textContent).toContain("missed");
    expect(rows[0]?.textContent).toContain("acct-9");
    expect(rows[0]?.textContent).toContain("Pin brute force");
    expect(rows[1]?.textContent).toContain("false");
    expect(rows[1]?.textContent).toContain("ghost");
    expect(rows[1]?.textContent).toContain("Impossible travel");
    expect(rows[2]?.textContent).toContain("caught");
    expect(rows[2]?.textContent).toContain("acct-7");
    expect(rows[2]?.textContent).toContain("Pin brute force");
  });

  it("shows the row time from resolvedAt, not the fabricated at", () => {
    // caught()'s at is fixed to 999 game seconds (16:39); resolvedAt is 65 (1:05).
    publish([caught({ seq: 0, resolvedAt: 65 })]);
    render(<DecisionsPanel />);
    expect(screen.getByText("1:05")).toBeDefined();
    expect(screen.queryByText("16:39")).toBeNull();
  });

  it("renders an entity-less false decision with no entity text", () => {
    publish([falseDecision({ seq: 0, resolvedAt: 10 })]);
    render(<DecisionsPanel />);
    const row = screen.getByRole("button");
    expect(row.textContent).toContain("false");
    expect(row.textContent).not.toContain("ghost");
  });

  it("selects a decision on row click, and toggles it off on re-click", () => {
    publish([caught({ seq: 5, resolvedAt: 10 })]);
    render(<DecisionsPanel />);
    const row = screen.getByRole("button");
    expect(row.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(row);
    expect(useGameStore.getState().decisionSelection).toEqual({ seq: 5 });
    expect(screen.getByRole("button").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button"));
    expect(useGameStore.getState().decisionSelection).toBeNull();
  });
});
