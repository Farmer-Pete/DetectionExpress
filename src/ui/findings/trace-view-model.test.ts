import { describe, expect, it } from "vitest";
import type { LiveFinding } from "../../sim/correctness";
import type { Finding } from "../../sim/finding";
import type { RingEvent } from "../../sim/inspector";
import { emptySnapshot, type SimSnapshot } from "../../sim/snapshot";
import { buildTraceViewModel } from "./trace-view-model";

/** One ring event, distinguishable by id. */
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

/** One LiveFinding, defaulting to a hit anchored on eventId 0. `alert.at` is a
 *  fixed decoy (999): the view-model must read the trusted `LiveFinding.at`, never it. */
function live(
  over: { seq: number; eventIds: number[] } & Partial<Omit<LiveFinding, "finding">>,
): LiveFinding {
  const finding: Finding = {
    alert: { reason: over.reason ?? "pin_brute_force", at: 999, eventIds: over.eventIds },
    eventId: over.eventIds[0] ?? 0,
  };
  const result: LiveFinding = {
    finding,
    state: over.state ?? "hit",
    reason: over.reason ?? "pin_brute_force",
    eventIds: over.eventIds,
    at: over.at ?? 5,
    seq: over.seq,
  };
  if (over.entity !== undefined) {
    result.entity = over.entity;
  }
  return result;
}

/** A snapshot carrying the given findings and ring events. */
function snapshot(findings: LiveFinding[], events: RingEvent[]): SimSnapshot {
  return { ...emptySnapshot(), findings, events };
}

describe("buildTraceViewModel", () => {
  it("returns null when the seq is not present in snapshot.findings", () => {
    const snap = snapshot([live({ seq: 1, eventIds: [0] })], [ringEvent(0)]);
    expect(buildTraceViewModel(snap, 99)).toBeNull();
  });

  it("builds one event card per cited id, in alert.eventIds order, resolved raw/normalized", () => {
    const snap = snapshot(
      [live({ seq: 1, eventIds: [5, 3, 1] })],
      [ringEvent(1), ringEvent(3), ringEvent(5)],
    );
    const model = buildTraceViewModel(snap, 1);
    expect(model?.cards).toEqual([
      {
        kind: "event",
        id: 5,
        ts: 50,
        endpoint: "kiosk-v1",
        raw: { at: "raw", id: 5 },
        normalized: { at: "normalized", id: 5 },
      },
      {
        kind: "event",
        id: 3,
        ts: 30,
        endpoint: "kiosk-v1",
        raw: { at: "raw", id: 3 },
        normalized: { at: "normalized", id: 3 },
      },
      {
        kind: "event",
        id: 1,
        ts: 10,
        endpoint: "kiosk-v1",
        raw: { at: "raw", id: 1 },
        normalized: { at: "normalized", id: 1 },
      },
    ]);
  });

  it("emits an aged-out placeholder card for a cited id missing from snapshot.events", () => {
    const snap = snapshot([live({ seq: 1, eventIds: [0, 1, 2] })], [ringEvent(1)]);
    const model = buildTraceViewModel(snap, 1);
    expect(model?.cards).toEqual([
      { kind: "aged-out", id: 0 },
      {
        kind: "event",
        id: 1,
        ts: 10,
        endpoint: "kiosk-v1",
        raw: { at: "raw", id: 1 },
        normalized: { at: "normalized", id: 1 },
      },
      { kind: "aged-out", id: 2 },
    ]);
  });

  it("carries reason, state, entity, and the trusted `at`, never the finding's alert.at", () => {
    const snap = snapshot(
      [
        live({
          seq: 7,
          eventIds: [0],
          reason: "impossible_travel",
          state: "watch",
          entity: "acct-9",
          at: 42,
        }),
      ],
      [ringEvent(0)],
    );
    const model = buildTraceViewModel(snap, 7);
    expect(model?.reason).toBe("impossible_travel");
    expect(model?.state).toBe("watch");
    expect(model?.entity).toBe("acct-9");
    // `live.at` (42) is the trusted emission time; the fixture's finding.alert.at is 999.
    expect(model?.at).toBe(42);
  });

  it("omits entity when the finding names no subject", () => {
    const snap = snapshot([live({ seq: 1, eventIds: [0] })], [ringEvent(0)]);
    const model = buildTraceViewModel(snap, 1);
    expect(model?.entity).toBeUndefined();
  });

  it("carries the finding's context through unchanged, and omits it when absent", () => {
    const withContext = live({ seq: 1, eventIds: [0] });
    withContext.finding = {
      ...withContext.finding,
      context: [{ type: "text", text: "1 of 5 wrong PINs" }],
    };
    const snap = snapshot([withContext], [ringEvent(0)]);
    const model = buildTraceViewModel(snap, 1);
    expect(model?.context).toEqual([{ type: "text", text: "1 of 5 wrong PINs" }]);

    const withoutContext = live({ seq: 2, eventIds: [0] });
    const snap2 = snapshot([withoutContext], [ringEvent(0)]);
    expect(buildTraceViewModel(snap2, 2)?.context).toBeUndefined();
  });
});
