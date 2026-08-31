/**
 * The trace view-model: turns the selected `LiveFinding` and the current
 * `SimSnapshot` into the shape `TraceOverlay` renders. Pure and total, so it tests
 * with no DOM. Resolves each cited id (`alert.eventIds`) against `snapshot.events`,
 * the sampler's fresh copy of the inspector ring; a cited id the ring has already
 * evicted (aged out, past `RING_SIZE`) gets a placeholder card, never a silent
 * omission (GH34-35-PLAN.md decision 3/4). `null` means the seq named a finding no
 * longer in `snapshot.findings`, which the store's reconciliation would have
 * already cleared the selection for.
 */
import type { Context, JsonValue } from "../../sim/finding";
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
  /** One card per `alert.eventIds` entry, order preserved. */
  cards: TraceCard[];
  /** The finding's display widgets, when it carries any. */
  context?: Context;
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

  const cards: TraceCard[] = live.finding.alert.eventIds.map((id) => {
    const event = snapshot.events.find((candidate) => candidate.id === id);
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
