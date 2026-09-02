/**
 * The event dialog's adaptive detail view-model (GH124-PLAN.md Checkpoint 5): turns
 * one `WorldLogEvent` into what `EventDialog.tsx` renders. Pure and total, so it tests
 * without mounting React, mirroring `trace-view-model.ts` and `place-view.ts`.
 *
 * The detail adapts to what the reading actually is: a scored kiosk reading (one that
 * crossed the #117 boundary) can show the exact normalized record Detect scored, plus
 * every finding/decision that cites it, by reading `snapshot.events` (the scored
 * inspector ring) through its `scoredEventId` — no new engine tracking, since that ring
 * already exists. The world ring outlives the 256-entry inspector ring, so a scored
 * reading can still be present here after its inspector entry has aged out; that case
 * degrades to raw + citations with an explicit "no longer retained" state, never a
 * silent gap. Every other sensor (including a benign fare-gate tap) has no pipeline
 * event to show at all, so it gets the raw reading plus its source location and, when
 * it came from a live actor, that actor's id.
 */
import type { Decision, LiveFinding } from "../../sim/correctness";
import type { JsonValue } from "../../sim/finding";
import type { RingEvent } from "../../sim/inspector";
import type { MapNodeId } from "../../sim/world/presence";
import type { WorldLogEvent } from "../../sim/world-log";
import type { WorldReading } from "../../sim/world-reading";

/** A scored kiosk reading whose pipeline event is still in the inspector ring. */
export interface ScoredEventDetail {
  kind: "scored";
  raw: JsonValue;
  normalized: JsonValue;
  citingFindings: readonly LiveFinding[];
  citingDecisions: readonly Decision[];
}

/** A scored kiosk reading whose pipeline event has aged out of the 256-entry
 *  inspector ring, even though the wider world ring still holds this row. */
export interface ScoredEvictedEventDetail {
  kind: "scored-evicted";
  raw: WorldReading;
  citingFindings: readonly LiveFinding[];
  citingDecisions: readonly Decision[];
}

/** Every non-scored sensor: the raw reading plus where (and, for a live actor, who)
 *  produced it. */
export interface RawEventDetail {
  kind: "raw";
  raw: WorldReading;
  source: { placeId: MapNodeId; actorId?: string };
}

export type EventDetail = ScoredEventDetail | ScoredEvictedEventDetail | RawEventDetail;

/** A decision cites an event through its finding's `alert.eventIds`; a missed
 *  decision has no finding (and so no eventIds) and can never cite anything. */
function decisionCites(decision: Decision, eventId: number): boolean {
  return decision.outcome !== "missed" && decision.finding.alert.eventIds.includes(eventId);
}

/**
 * Build the adaptive detail for `ev`. `snapshotEvents` is the published
 * `snapshot.events` (the scored inspector ring); `findings`/`decisions` are the
 * published `snapshot.findings`/`snapshot.decisions`. Total: every `WorldLogEvent` the
 * ring can hold produces exactly one of the three `EventDetail` shapes.
 */
export function eventDetail(
  ev: WorldLogEvent,
  snapshotEvents: readonly RingEvent[],
  findings: readonly LiveFinding[],
  decisions: readonly Decision[],
): EventDetail {
  if (ev.scored && ev.scoredEventId !== undefined) {
    const scoredEventId = ev.scoredEventId;
    const citingFindings = findings.filter((finding) => finding.eventIds.includes(scoredEventId));
    const citingDecisions = decisions.filter((decision) => decisionCites(decision, scoredEventId));
    const ringEvent = snapshotEvents.find((candidate) => candidate.id === scoredEventId);
    if (ringEvent === undefined) {
      return { kind: "scored-evicted", raw: ev.reading, citingFindings, citingDecisions };
    }
    return {
      kind: "scored",
      raw: ringEvent.raw,
      normalized: ringEvent.normalized,
      citingFindings,
      citingDecisions,
    };
  }
  const source: RawEventDetail["source"] =
    ev.actorId === undefined
      ? { placeId: ev.placeId }
      : { placeId: ev.placeId, actorId: ev.actorId };
  return { kind: "raw", raw: ev.reading, source };
}
