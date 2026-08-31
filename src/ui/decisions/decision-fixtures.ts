/**
 * Shared decision-fixture builders for the UI test suites (T10): `trace-view-model.test.ts`,
 * `TraceOverlay.test.tsx`, `decisions/view-model.test.ts`, and `DecisionsPanel.test.tsx` each
 * built their own copy of a caught/false/missed `Decision`; this is the one place that shape
 * lives now, so the four never drift apart. Test-only: nothing outside a test file should
 * import it.
 */
import type { CaughtDecision, FalseDecision, MissedDecision } from "../../sim/correctness";
import type { Context, Finding } from "../../sim/finding";
import type { RingEvent } from "../../sim/inspector";

/** Overrides shared by `caughtDecision` and `falseDecision`. `eventIds` defaults to `[0]`,
 *  the single-event shape most tests don't care to vary. */
export interface EvidenceDecisionOverrides {
  seq: number;
  eventIds?: number[];
  citedEvents?: RingEvent[];
  entity?: string;
  resolvedAt?: number;
  context?: Context;
}

/** Overrides for `missedDecision`. */
export interface MissedDecisionOverrides {
  seq: number;
  resolvedAt?: number;
  window?: { startTs: number; endTs: number };
}

/** A caught decision. `at` is a fabricated decoy (999); the trusted time is `resolvedAt`. */
export function caughtDecision(over: EvidenceDecisionOverrides): CaughtDecision {
  const eventIds = over.eventIds ?? [0];
  const finding: Finding = {
    alert: { reason: "pin_brute_force", at: 999, eventIds },
    eventId: eventIds[0] ?? 0,
    ...(over.context !== undefined ? { context: over.context } : {}),
  };
  return {
    outcome: "caught",
    seq: over.seq,
    at: 999,
    resolvedAt: over.resolvedAt ?? 5,
    attackId: 1,
    entity: over.entity ?? "acct-7",
    finding,
    citedEvents: over.citedEvents ?? [],
  };
}

/** A false decision, optionally with no resolved entity (omit `entity` to leave it unset). */
export function falseDecision(over: EvidenceDecisionOverrides): FalseDecision {
  const eventIds = over.eventIds ?? [0];
  const decision: FalseDecision = {
    outcome: "false",
    seq: over.seq,
    at: 999,
    resolvedAt: over.resolvedAt ?? 5,
    finding: {
      alert: { reason: "impossible_travel", at: 999, eventIds },
      eventId: eventIds[0] ?? 0,
      ...(over.context !== undefined ? { context: over.context } : {}),
    },
    citedEvents: over.citedEvents ?? [],
  };
  if (over.entity !== undefined) {
    decision.entity = over.entity;
  }
  return decision;
}

/** A missed decision. An attack always names an entity, unlike a false decision's optional one. */
export function missedDecision(over: MissedDecisionOverrides): MissedDecision {
  const window = over.window ?? { startTs: 0, endTs: 100 };
  return {
    outcome: "missed",
    seq: over.seq,
    at: over.resolvedAt ?? window.endTs,
    resolvedAt: over.resolvedAt ?? window.endTs,
    attackId: 1,
    entity: "acct-9",
    reason: "pin_brute_force",
    window,
  };
}
