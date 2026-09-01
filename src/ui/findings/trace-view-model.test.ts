import { describe, expect, it } from "vitest";
import type { Decision, LiveFinding } from "../../sim/correctness";
import type { Finding } from "../../sim/finding";
import type { RingEvent } from "../../sim/inspector";
import { emptySnapshot, type SimSnapshot } from "../../sim/snapshot";
import { caughtDecision, falseDecision, missedDecision } from "../decisions/decision-fixtures";
import { buildDecisionTraceViewModel, buildTraceViewModel } from "./trace-view-model";

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
    citedEvents: over.citedEvents ?? [],
  };
  if (over.entity !== undefined) {
    result.entity = over.entity;
  }
  return result;
}

/** A snapshot carrying the given findings and, when passed, ring events. Finding mode no
 *  longer reads `snapshot.events` for its cards (it resolves against the finding's own
 *  frozen `citedEvents`), so most fixtures below omit `events` entirely; the conflict
 *  test below is the one place a mismatched ring matters. */
function snapshot(findings: LiveFinding[], events: RingEvent[] = []): SimSnapshot {
  return { ...emptySnapshot(), findings, events };
}

describe("buildTraceViewModel", () => {
  it("returns null when the seq is not present in snapshot.findings", () => {
    const snap = snapshot([live({ seq: 1, eventIds: [0] })], [ringEvent(0)]);
    expect(buildTraceViewModel(snap, 99)).toBeNull();
  });

  it("builds one event card per cited id, in alert.eventIds order, resolved raw/normalized", () => {
    const snap = snapshot([
      live({
        seq: 1,
        eventIds: [5, 3, 1],
        citedEvents: [ringEvent(1), ringEvent(3), ringEvent(5)],
      }),
    ]);
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

  it("emits an aged-out placeholder card for a cited id missing from citedEvents", () => {
    const snap = snapshot([live({ seq: 1, eventIds: [0, 1, 2], citedEvents: [ringEvent(1)] })]);
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

  it("dedups a repeated cited id to one card, keeping first-occurrence order", () => {
    const snap = snapshot([
      live({ seq: 1, eventIds: [7, 3, 7], citedEvents: [ringEvent(3), ringEvent(7)] }),
    ]);
    const model = buildTraceViewModel(snap, 1);
    expect(model?.cards.map((card) => card.id)).toEqual([7, 3]);
  });

  it("dedups a repeated missing id to one aged-out placeholder", () => {
    const snap = snapshot([live({ seq: 1, eventIds: [9, 9] })], []);
    const model = buildTraceViewModel(snap, 1);
    expect(model?.cards).toEqual([{ kind: "aged-out", id: 9 }]);
  });

  it("carries reason, state, entity, and the trusted `at`, never the finding's alert.at", () => {
    const snap = snapshot([
      live({
        seq: 7,
        eventIds: [0],
        reason: "impossible_travel",
        state: "watch",
        entity: "acct-9",
        at: 42,
        citedEvents: [ringEvent(0)],
      }),
    ]);
    const model = buildTraceViewModel(snap, 7);
    expect(model?.reason).toBe("impossible_travel");
    expect(model?.state).toBe("watch");
    expect(model?.entity).toBe("acct-9");
    // `live.at` (42) is the trusted emission time; the fixture's finding.alert.at is 999.
    expect(model?.at).toBe(42);
  });

  it("omits entity when the finding names no subject", () => {
    const snap = snapshot([live({ seq: 1, eventIds: [0], citedEvents: [ringEvent(0)] })]);
    const model = buildTraceViewModel(snap, 1);
    expect(model?.entity).toBeUndefined();
  });

  it("carries the finding's context through unchanged, and omits it when absent", () => {
    const withContext = live({ seq: 1, eventIds: [0], citedEvents: [ringEvent(0)] });
    withContext.finding = {
      ...withContext.finding,
      context: [{ type: "text", text: "1 of 5 wrong PINs" }],
    };
    const snap = snapshot([withContext]);
    const model = buildTraceViewModel(snap, 1);
    expect(model?.context).toEqual([{ type: "text", text: "1 of 5 wrong PINs" }]);

    const withoutContext = live({ seq: 2, eventIds: [0], citedEvents: [ringEvent(0)] });
    const snap2 = snapshot([withoutContext]);
    expect(buildTraceViewModel(snap2, 2)?.context).toBeUndefined();
  });

  it("resolves finding-mode cards from citedEvents, never falling back to snapshot.events", () => {
    const snap = snapshot(
      [live({ seq: 1, eventIds: [0, 1], citedEvents: [ringEvent(1)] })],
      // The live ring DOES carry id 0, and a differently-shaped id 1, but the finding's
      // own frozen citedEvents wins either way: id 0 stays aged-out (absent from
      // citedEvents, despite being in the ring) and id 1 resolves to the citedEvents
      // copy, not the ring's decoy.
      [ringEvent(0), ringEvent(1, { endpoint: "decoy" })],
    );
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
    ]);
  });
});

/** A snapshot carrying the given decisions, otherwise empty. */
function snapshotWithDecisions(decisions: Decision[]): SimSnapshot {
  return { ...emptySnapshot(), decisions };
}

describe("buildDecisionTraceViewModel", () => {
  it("returns null when the seq is not present in snapshot.decisions", () => {
    const snap = snapshotWithDecisions([caughtDecision({ seq: 1, eventIds: [0] })]);
    expect(buildDecisionTraceViewModel(snap, 99)).toBeNull();
  });

  it("builds an evidence view for a caught decision, cards resolved against citedEvents", () => {
    const snap = snapshotWithDecisions([
      caughtDecision({
        seq: 1,
        eventIds: [5, 3, 1],
        citedEvents: [ringEvent(1), ringEvent(3), ringEvent(5)],
        entity: "acct-7",
        resolvedAt: 42,
      }),
    ]);
    const model = buildDecisionTraceViewModel(snap, 1);
    expect(model?.kind).toBe("evidence");
    if (model?.kind !== "evidence") return;
    expect(model.outcome).toBe("caught");
    expect(model.entity).toBe("acct-7");
    expect(model.reason).toBe("pin_brute_force");
    expect(model.resolvedAt).toBe(42);
    expect(model.cards).toEqual([
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

  it("emits an aged-out placeholder for a cited id missing from citedEvents, not snapshot.events", () => {
    const snap: SimSnapshot = {
      ...emptySnapshot(),
      // The live ring DOES carry id 0, but the frozen decision does not: the decision
      // must resolve against its own citedEvents, never fall back to the live ring.
      events: [ringEvent(0)],
      decisions: [caughtDecision({ seq: 1, eventIds: [0, 1], citedEvents: [ringEvent(1)] })],
    };
    const model = buildDecisionTraceViewModel(snap, 1);
    if (model?.kind !== "evidence") throw new Error("expected an evidence view");
    expect(model.cards).toEqual([
      { kind: "aged-out", id: 0 },
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

  it("carries the frozen finding's context through unchanged, and omits it when absent", () => {
    const snap = snapshotWithDecisions([
      caughtDecision({
        seq: 1,
        eventIds: [0],
        context: [{ type: "text", text: "orig" }],
      }),
    ]);
    const model = buildDecisionTraceViewModel(snap, 1);
    if (model?.kind !== "evidence") throw new Error("expected an evidence view");
    expect(model.context).toEqual([{ type: "text", text: "orig" }]);

    const bare = snapshotWithDecisions([caughtDecision({ seq: 2, eventIds: [0] })]);
    const bareModel = buildDecisionTraceViewModel(bare, 2);
    if (bareModel?.kind !== "evidence") throw new Error("expected an evidence view");
    expect(bareModel.context).toBeUndefined();
  });

  it("dedups a decision's repeated cited id to one card, keeping first-occurrence order", () => {
    const snap = snapshotWithDecisions([
      caughtDecision({
        seq: 1,
        eventIds: [7, 3, 7],
        citedEvents: [ringEvent(3), ringEvent(7)],
      }),
    ]);
    const model = buildDecisionTraceViewModel(snap, 1);
    if (model?.kind !== "evidence") throw new Error("expected an evidence view");
    expect(model.cards.map((card) => card.id)).toEqual([7, 3]);
  });

  it("builds a false decision's evidence view, entity null when the finding named no subject", () => {
    const snap = snapshotWithDecisions([falseDecision({ seq: 1, eventIds: [0] })]);
    const model = buildDecisionTraceViewModel(snap, 1);
    if (model?.kind !== "evidence") throw new Error("expected an evidence view");
    expect(model.outcome).toBe("false");
    expect(model.entity).toBeNull();
    expect(model.reason).toBe("impossible_travel");
  });

  it("carries a false decision's resolved entity when it has one", () => {
    const snap = snapshotWithDecisions([falseDecision({ seq: 1, eventIds: [0], entity: "ghost" })]);
    const model = buildDecisionTraceViewModel(snap, 1);
    if (model?.kind !== "evidence") throw new Error("expected an evidence view");
    expect(model.entity).toBe("ghost");
  });

  it("builds a missed view: entity, reason, resolvedAt, and the attack window, no cards", () => {
    const snap = snapshotWithDecisions([
      missedDecision({ seq: 1, window: { startTs: 5, endTs: 100 } }),
    ]);
    const model = buildDecisionTraceViewModel(snap, 1);
    expect(model).toEqual({
      kind: "missed",
      entity: "acct-9",
      reason: "pin_brute_force",
      resolvedAt: 100,
      window: { startTs: 5, endTs: 100 },
    });
  });
});
