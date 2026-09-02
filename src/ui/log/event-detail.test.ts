import { describe, expect, it } from "vitest";
import type { LiveFinding } from "../../sim/correctness";
import type { Finding } from "../../sim/finding";
import type { RingEvent } from "../../sim/inspector";
import type { WorldLogEvent } from "../../sim/world-log";
import { caughtDecision, falseDecision, missedDecision } from "../decisions/decision-fixtures";
import { eventDetail } from "./event-detail";

function ringEvent(id: number, over: Partial<RingEvent> = {}): RingEvent {
  return {
    id,
    ts: id * 10,
    endpoint: "kiosk-v1",
    raw: { at: "raw", id },
    normalized: { at: "normalized", id },
    ...over,
  };
}

function live(
  over: { seq: number; eventIds: number[] } & Partial<Omit<LiveFinding, "finding">>,
): LiveFinding {
  const finding: Finding = {
    alert: { reason: over.reason ?? "pin_brute_force", at: 999, eventIds: over.eventIds },
    eventId: over.eventIds[0] ?? 0,
  };
  return {
    finding,
    state: over.state ?? "hit",
    reason: over.reason ?? "pin_brute_force",
    eventIds: over.eventIds,
    at: over.at ?? 5,
    seq: over.seq,
    citedEvents: over.citedEvents ?? [],
  };
}

function kioskWorldEvent(over: Partial<WorldLogEvent> = {}): WorldLogEvent {
  return {
    id: 0,
    ts: 12,
    sensor: "kiosk",
    placeId: "cen",
    chipNode: "cen:kiosk",
    actorId: "patron-0",
    reading: {
      sensor: "kiosk",
      reading: { ts: 12, account: "rider", station: "cen", terminal: "K1", outcome: "success" },
    },
    scored: false,
    ...over,
  };
}

function fareGateWorldEvent(over: Partial<WorldLogEvent> = {}): WorldLogEvent {
  return {
    id: 1,
    ts: 12,
    sensor: "fare-gate",
    placeId: "cen",
    chipNode: "cen:gate",
    reading: {
      sensor: "fare-gate",
      reading: {
        ts: 12,
        card: "card-1",
        station: "cen",
        line: "red",
        direction: "in",
        result: "ok",
        balance: 50,
      },
    },
    scored: false,
    ...over,
  };
}

describe("eventDetail: a scored kiosk reading still in the inspector ring", () => {
  it("returns raw + normalized from snapshot.events, resolved by scoredEventId", () => {
    const ev = kioskWorldEvent({ scored: true, scoredEventId: 7 });
    const detail = eventDetail(ev, [ringEvent(7)], [], []);
    expect(detail).toEqual({
      kind: "scored",
      raw: { at: "raw", id: 7 },
      normalized: { at: "normalized", id: 7 },
      citingFindings: [],
      citingDecisions: [],
    });
  });

  it("includes findings and caught/false decisions that cite the scoredEventId, excluding ones that don't", () => {
    const ev = kioskWorldEvent({ scored: true, scoredEventId: 7 });
    const citingFinding = live({ seq: 1, eventIds: [7] });
    const otherFinding = live({ seq: 2, eventIds: [3] });
    const citingDecision = caughtDecision({ seq: 10, eventIds: [7] });
    const otherDecision = falseDecision({ seq: 11, eventIds: [3] });
    const miss = missedDecision({ seq: 12 }); // never cites anything

    const detail = eventDetail(
      ev,
      [ringEvent(7)],
      [citingFinding, otherFinding],
      [citingDecision, otherDecision, miss],
    );
    if (detail.kind !== "scored") throw new Error("expected scored detail");
    expect(detail.citingFindings).toEqual([citingFinding]);
    expect(detail.citingDecisions).toEqual([citingDecision]);
  });
});

describe("eventDetail: a scored kiosk reading evicted from the inspector ring", () => {
  it("returns raw (the world log's own copy) + citations, with no normalized field", () => {
    const ev = kioskWorldEvent({ scored: true, scoredEventId: 7 });
    const citingFinding = live({ seq: 1, eventIds: [7] });
    // snapshot.events (the 256-entry inspector ring) no longer holds id 7, even though
    // the wider world ring still carries this row.
    const detail = eventDetail(ev, [], [citingFinding], []);
    expect(detail).toEqual({
      kind: "scored-evicted",
      raw: ev.reading,
      citingFindings: [citingFinding],
      citingDecisions: [],
    });
    expect("normalized" in detail).toBe(false);
  });
});

describe("eventDetail: every non-scored sensor", () => {
  it("returns the raw reading plus its place and actor source", () => {
    const ev = kioskWorldEvent({ actorId: "A-amb" });
    const detail = eventDetail(ev, [], [], []);
    expect(detail).toEqual({
      kind: "raw",
      raw: ev.reading,
      source: { placeId: "cen", actorId: "A-amb" },
    });
  });

  it("omits actorId from source for a reducer-synthesized reading with no actor", () => {
    const ev = fareGateWorldEvent(); // the base fixture carries no actorId
    const detail = eventDetail(ev, [], [], []);
    if (detail.kind !== "raw") throw new Error("expected raw detail");
    expect(detail.source).toEqual({ placeId: "cen" });
    expect("actorId" in detail.source).toBe(false);
  });

  it("ignores snapshot.events/findings/decisions entirely for an unscored reading", () => {
    const ev = fareGateWorldEvent();
    const detail = eventDetail(ev, [ringEvent(0)], [live({ seq: 1, eventIds: [0] })], []);
    expect(detail.kind).toBe("raw");
  });
});
