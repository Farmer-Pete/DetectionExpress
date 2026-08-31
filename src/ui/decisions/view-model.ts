/**
 * The decisions view model. Turns `SimSnapshot.decisions`, the scorer's seq-ascending
 * capped log, into the newest-first rows the strip renders. Pure and total, so it
 * tests with no DOM.
 */
import type { Decision, DecisionOutcome } from "../../sim/correctness";
import { prettifyReason } from "../findings/view-model";

/** One row: an outcome tag, the resolved entity (or none), a label, and a time. */
export interface DecisionRow {
  /** Stable insertion id; selection keys on it. */
  seq: number;
  outcome: DecisionOutcome;
  /** The resolved subject, or null for an entity-less false decision. */
  entity: string | null;
  /** The prettified reason, for display. */
  reason: string;
  /**
   * The row's displayed time: the decision's trusted `resolvedAt`, never the
   * player-influenced `at` (GH34-35-PLAN.md decision 16).
   */
  time: number;
}

/** Shape one resolved decision into a row. */
function toRow(decision: Decision): DecisionRow {
  switch (decision.outcome) {
    case "caught":
      return {
        seq: decision.seq,
        outcome: "caught",
        entity: decision.entity,
        reason: prettifyReason(decision.finding.alert.reason),
        time: decision.resolvedAt,
      };
    case "false":
      return {
        seq: decision.seq,
        outcome: "false",
        entity: decision.entity ?? null,
        reason: prettifyReason(decision.finding.alert.reason),
        time: decision.resolvedAt,
      };
    case "missed":
      return {
        seq: decision.seq,
        outcome: "missed",
        entity: decision.entity,
        reason: prettifyReason(decision.reason),
        time: decision.resolvedAt,
      };
  }
}

/** Map the decision log to rows, newest first (the log itself is seq-ascending). */
export function buildDecisionRows(decisions: readonly Decision[]): DecisionRow[] {
  return [...decisions].reverse().map(toRow);
}

/**
 * The player-facing label for a decision outcome, replacing the raw "caught" /
 * "missed" / "false" token. Display text only: the CSS class a caller keys on
 * stays on the raw token.
 */
export function outcomeLabel(outcome: DecisionOutcome): "Caught" | "Missed" | "False alert" {
  switch (outcome) {
    case "caught":
      return "Caught";
    case "missed":
      return "Missed";
    case "false":
      return "False alert";
  }
}
