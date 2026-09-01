/**
 * The trace view-model: turns the selected `LiveFinding` and the current
 * `SimSnapshot` into the shape `TraceOverlay` renders. Pure and total, so it tests
 * with no DOM. Resolves each cited id (`alert.eventIds`) against the finding's own
 * frozen `citedEvents` (accumulated across its emissions, see
 * `LiveFinding.citedEvents`), never the churning `snapshot.events` ring; a cited id
 * never resolvable while it was captured gets a placeholder card, never a silent
 * omission (GH34-35-PLAN.md decision 3/4). `null` means the seq named a finding no
 * longer in `snapshot.findings`, which the store's reconciliation would have
 * already cleared the selection for.
 */
import type { DecisionOutcome } from "../../sim/correctness";
import type { Context, JsonValue } from "../../sim/finding";
import type { RingEvent } from "../../sim/inspector";
import type { SimSnapshot } from "../../sim/snapshot";

/** One cited event, resolved: its raw and normalized payload, ready to render. Not
 *  exported on its own; consumers narrow on `TraceCard.kind` instead. */
interface TraceEventCard {
  kind: "event";
  id: number;
  ts: number;
  endpoint: string;
  raw: JsonValue;
  normalized: JsonValue;
}

/** A cited id the ring has already evicted. Rendered as a placeholder, not omitted. */
interface TraceAgedOutCard {
  kind: "aged-out";
  id: number;
}

export type TraceCard = TraceEventCard | TraceAgedOutCard;

export interface TraceViewModel {
  /** The resolved subject, when the finding names one. */
  entity?: string;
  /** `alert.reason`: the hunt id. */
  reason: string;
  /** "watch" for a partial, "hit" for a final. */
  state: "hit" | "watch";
  /** `LiveFinding.at`: the trusted emission time, never `alert.at`. */
  at: number;
  /** One card per distinct cited id, first-occurrence order preserved. */
  cards: TraceCard[];
  /** The finding's display widgets, when it carries any. */
  context?: Context;
}

/** `alert.eventIds` deduped, first-occurrence order preserved, matching the
 *  set-semantics `resolveEvents` and the scorer's `hitsFor` already apply. */
function dedupIds(ids: readonly number[]): number[] {
  return [...new Set(ids)];
}

/**
 * Resolve `ids` (deduped, first-occurrence order preserved) against `source`,
 * one card per id: an event card when `source` carries it, an aged-out
 * placeholder when it does not. Shared by finding mode (resolving against the
 * finding's own frozen `citedEvents`) and decision mode (resolving against a
 * decision's own frozen `citedEvents`) — the only difference between the two
 * is which `source` the caller passes in.
 */
function toCards(ids: readonly number[], source: readonly RingEvent[]): TraceCard[] {
  return dedupIds(ids).map((id) => {
    const event = source.find((candidate) => candidate.id === id);
    if (event === undefined) {
      return { kind: "aged-out", id };
    }
    return {
      kind: "event",
      id,
      ts: event.ts,
      endpoint: event.endpoint,
      raw: event.raw,
      normalized: event.normalized,
    };
  });
}

/**
 * Build the trace view-model for the finding at `seq`, or `null` when no live
 * finding in `snapshot.findings` carries that seq.
 */
export function buildTraceViewModel(snapshot: SimSnapshot, seq: number): TraceViewModel | null {
  const live = snapshot.findings.find((finding) => finding.seq === seq);
  if (live === undefined) {
    return null;
  }

  const cards = toCards(live.finding.alert.eventIds, live.citedEvents);

  const model: TraceViewModel = {
    reason: live.reason,
    state: live.state,
    at: live.at,
    cards,
  };
  // `exactOptionalPropertyTypes`: only set when present, never to `undefined`.
  if (live.entity !== undefined) {
    model.entity = live.entity;
  }
  if (live.finding.context !== undefined) {
    model.context = live.finding.context;
  }
  return model;
}

/**
 * A caught or false decision reopened: the frozen evidence exactly as it stood at
 * decision time. `cards` resolves `alert.eventIds` against the decision's own
 * `citedEvents` (T10, captured at append time), never the live `snapshot.events`
 * ring, which may have moved on or been evicted entirely by the time a player
 * reopens old history. Not exported on its own; consumers narrow on
 * `DecisionTraceViewModel.kind` instead.
 */
interface DecisionTraceEvidence {
  kind: "evidence";
  outcome: Extract<DecisionOutcome, "caught" | "false">;
  /** The resolved subject, or null for an entity-less false decision. */
  entity: string | null;
  /** `alert.reason`: the hunt id. */
  reason: string;
  /** The trusted resolution time (GH34-35-PLAN.md decision 16), never `at`. */
  resolvedAt: number;
  /** One card per distinct cited id, first-occurrence order preserved. */
  cards: TraceCard[];
  /** The frozen finding's display widgets, when it carries any. */
  context?: Context;
}

/** A missed decision reopened: reason and the attack window only, no evidence pane
 *  (GH34-35-PLAN.md decision 12: there was no finding to show). */
interface DecisionTraceMissed {
  kind: "missed";
  /** The attack's entity: a miss always names one, unlike a false decision's optional one. */
  entity: string;
  reason: string;
  resolvedAt: number;
  window: { startTs: number; endTs: number };
}

export type DecisionTraceViewModel = DecisionTraceEvidence | DecisionTraceMissed;

/**
 * Build the decision-mode trace view-model for the decision at `seq`, or `null`
 * when no decision in `snapshot.decisions` carries that seq (the cap or a run
 * restart dropped it; the store's reconciliation would have already cleared the
 * selection for it too).
 */
export function buildDecisionTraceViewModel(
  snapshot: SimSnapshot,
  seq: number,
): DecisionTraceViewModel | null {
  const decision = snapshot.decisions.find((candidate) => candidate.seq === seq);
  if (decision === undefined) {
    return null;
  }

  if (decision.outcome === "missed") {
    return {
      kind: "missed",
      entity: decision.entity,
      reason: decision.reason,
      resolvedAt: decision.resolvedAt,
      window: { startTs: decision.window.startTs, endTs: decision.window.endTs },
    };
  }

  const cards = toCards(decision.finding.alert.eventIds, decision.citedEvents);

  const model: DecisionTraceEvidence = {
    kind: "evidence",
    outcome: decision.outcome,
    entity: decision.entity ?? null,
    reason: decision.finding.alert.reason,
    resolvedAt: decision.resolvedAt,
    cards,
  };
  if (decision.finding.context !== undefined) {
    model.context = decision.finding.context;
  }
  return model;
}
