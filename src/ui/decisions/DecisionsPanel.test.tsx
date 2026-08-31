import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useGameStore } from "../../game/store";
import type { Decision } from "../../sim/correctness";
import { emptySnapshot, type SimSnapshot } from "../../sim/snapshot";
import { DecisionsPanel } from "./DecisionsPanel";
import { caughtDecision, falseDecision, missedDecision } from "./decision-fixtures";

// The zustand store is a singleton shared across test files, so reset the fields this
// file reads before each test, mirroring the reset pattern in FindingsPanel.test.tsx.
beforeEach(() => {
  useGameStore.setState({ snapshot: emptySnapshot(), decisionSelection: null, selection: null });
});

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
      caughtDecision({ seq: 0, resolvedAt: 10, entity: "acct-7" }),
      falseDecision({ seq: 1, resolvedAt: 20, entity: "ghost" }),
      missedDecision({ seq: 2, resolvedAt: 30 }),
    ]);
    render(<DecisionsPanel />);
    const rows = screen.getAllByRole("button");
    expect(rows).toHaveLength(3);
    // Newest first: seq 2 (missed), then 1 (false), then 0 (caught).
    expect(rows[0]?.textContent).toContain("Missed");
    expect(rows[0]?.textContent).toContain("acct-9");
    expect(rows[0]?.textContent).toContain("Pin brute force");
    expect(rows[1]?.textContent).toContain("False alert");
    expect(rows[1]?.textContent).toContain("ghost");
    expect(rows[1]?.textContent).toContain("Impossible travel");
    expect(rows[2]?.textContent).toContain("Caught");
    expect(rows[2]?.textContent).toContain("acct-7");
    expect(rows[2]?.textContent).toContain("Pin brute force");
  });

  it("shows the row time from resolvedAt, not the fabricated at", () => {
    // caughtDecision()'s at is fixed to 999 game seconds (16:39); resolvedAt is 65 (1:05).
    publish([caughtDecision({ seq: 0, resolvedAt: 65 })]);
    render(<DecisionsPanel />);
    expect(screen.getByText("1:05")).toBeDefined();
    expect(screen.queryByText("16:39")).toBeNull();
  });

  it("renders an entity-less false decision with no entity chip", () => {
    publish([falseDecision({ seq: 0, resolvedAt: 10 })]);
    render(<DecisionsPanel />);
    const row = screen.getByRole("button");
    expect(row.textContent).toContain("False alert");
    expect(row.querySelector(".decisions-entity")).toBeNull();
  });

  it("selects a decision on row click, and toggles it off on re-click", () => {
    publish([caughtDecision({ seq: 5, resolvedAt: 10 })]);
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
