import { describe, expect, it } from "vitest";
import type { Attack } from "./attack";
import {
  type CaughtDecision,
  type Counts,
  createScorer,
  type Decision,
  type DecisionOutcome,
  type FalseDecision,
  type MissedDecision,
  type ScoredFinding,
  type ScorerConfig,
  score,
} from "./correctness";
import type { PipeEvent } from "./event";
import type { Finding } from "./finding";
import type { RingEvent } from "./inspector";

const REASON = "pin_brute_force";

function counts(caught: number, missed: number, falseAlerts: number): Counts {
  return { caught, missed, falseAlerts };
}

// The pre-GH42 suite's implicit global threshold was 2 (the old `cfg()` default);
// this fixture default keeps every call site that never cared about the exact
// value unchanged now that `Attack.threshold` is required per-Attack.
function attack(
  id: number,
  entity: string,
  startTs: number,
  endTs: number,
  eventIds: number[],
  threshold = 2,
): Attack {
  return {
    id,
    entity,
    reason: REASON,
    window: { startTs, endTs },
    eventIds,
    threshold,
  };
}

/** A bare Event carrying only the scheduled time the scorer folds on. */
function at(ts: number): PipeEvent {
  return { id: 0, ts, endpoint: "kiosk-v1", payload: null };
}

/**
 * A resolved (non-partial) finding citing the given evidence. The anchor is the
 * first cited id, so it stays tied to this fixture's own evidence rather than an
 * arbitrary constant. An empty `eventIds` has no valid anchor and is a fixture bug.
 */
function found(eventIds: number[], ts: number, reason = REASON): Finding {
  const anchor = eventIds[0];
  if (anchor === undefined) {
    throw new Error("found() needs at least one cited event to anchor on");
  }
  return { alert: { reason, at: ts, eventIds }, eventId: anchor };
}

/** Wrap a finding as the Detect task would, with an optional resolved entity. */
function sf(finding: Finding, entity?: string): ScoredFinding {
  return entity === undefined ? { finding } : { finding, entity };
}

/** One resolved reason-only finding, the common Seam-A shape. */
function one(eventIds: number[], ts: number, reason = REASON): ScoredFinding[] {
  return [sf(found(eventIds, ts, reason))];
}

function cfg(over: Partial<ScorerConfig> = {}): ScorerConfig {
  return { window: 40, wFn: 3, wFp: 1, ...over };
}

/** Narrow a decision to `caught`, failing the test if it is any other outcome. */
function asCaught(decision: Decision | undefined): CaughtDecision {
  if (decision?.outcome !== "caught") {
    throw new Error(`expected a caught decision, got ${decision?.outcome ?? "none"}`);
  }
  return decision;
}

/** Narrow a decision to `false`. */
function asFalse(decision: Decision | undefined): FalseDecision {
  if (decision?.outcome !== "false") {
    throw new Error(`expected a false decision, got ${decision?.outcome ?? "none"}`);
  }
  return decision;
}

/** Narrow a decision to `missed`. */
function asMissed(decision: Decision | undefined): MissedDecision {
  if (decision?.outcome !== "missed") {
    throw new Error(`expected a missed decision, got ${decision?.outcome ?? "none"}`);
  }
  return decision;
}

describe("score", () => {
  it("reads 100 when the denominator is zero", () => {
    expect(score(counts(0, 0, 0), 3, 1)).toBe(100);
    expect(score(counts(3, 0, 0), 3, 1)).toBe(100);
  });

  it("lowers for a miss more than for a false alert", () => {
    expect(score(counts(1, 1, 0), 3, 1)).toBeCloseTo(25); // 100 * 1 / (1 + 3)
    expect(score(counts(1, 0, 1), 3, 1)).toBeCloseTo(50); // 100 * 1 / (1 + 1)
  });
});

// Seam A + E: the reason path and reading() are byte-for-byte today's behavior when
// entityMatch is off. Every case here is ported straight from the pre-T2 suite.
describe("scorer (reason path, entityMatch off)", () => {
  it("credits one pending Attack whose reason matches and evidence suffices", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg());
    s.record(one([10, 11], 50), at(50));
    s.finalize();
    expect(s.reading()).toEqual({ rolling: 100, caught: 1, missed: 0, falseAlerts: 0 });
  });

  it("misses an Attack whose window closes with no Finding", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg());
    s.record([], at(101)); // watermark passes endTs, so the window has closed
    const r = s.reading();
    expect(r.missed).toBe(1);
    expect(r.caught).toBe(0);
    expect(r.rolling).toBe(0); // 100 * 0 / (0 + 3)
  });

  it("counts a Finding that credits no Attack as a false alert", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg());
    s.record(one([99, 98], 50), at(50)); // cites ids no Attack owns
    expect(s.reading().falseAlerts).toBe(1);
    expect(s.reading().caught).toBe(0);
  });

  it("needs the threshold of DISTINCT cited ids; repeats do not qualify", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg());
    s.record(one([10, 10, 10], 50), at(50)); // one distinct id, threshold is two
    expect(s.reading().falseAlerts).toBe(1);
    expect(s.reading().caught).toBe(0);
  });

  it("treats a too-little-evidence Finding as false", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11, 12], 3)], cfg());
    s.record(one([10, 11], 50), at(50)); // two of three, below threshold
    expect(s.reading().falseAlerts).toBe(1);
    expect(s.reading().caught).toBe(0);
  });

  it("treats a duplicate Finding on a caught Attack as false", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg());
    s.record(one([10, 11], 50), at(50));
    s.record(one([10, 11], 60), at(60));
    expect(s.reading().caught).toBe(1);
    expect(s.reading().falseAlerts).toBe(1);
  });

  it("closes an expired Attack before scoring the same Event's Finding", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg());
    // The Event's ts is past endTs, so the Attack closes as a miss, and the late
    // Finding riding the same Event finds it resolved and scores as a false alert.
    s.record(one([10, 11], 101), at(101));
    const r = s.reading();
    expect(r.missed).toBe(1);
    expect(r.falseAlerts).toBe(1);
    expect(r.caught).toBe(0);
  });

  it("still credits a Finding on an Event exactly at endTs", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg());
    s.record(one([10, 11], 100), at(100));
    expect(s.reading().caught).toBe(1);
    expect(s.reading().missed).toBe(0);
  });

  it("finalize closes every remaining pending Attack as a miss", () => {
    const s = createScorer(
      [attack(1, "a", 0, 100, [10, 11]), attack(2, "b", 0, 200, [20, 21])],
      cfg(),
    );
    s.record(one([10, 11], 50), at(50)); // catch the first
    s.finalize(); // the second never fired
    const r = s.reading();
    expect(r.caught).toBe(1);
    expect(r.missed).toBe(1);
  });

  it("counts a miss once even as later Events keep folding in", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg());
    s.record([], at(101)); // expires here
    s.record([], at(150));
    s.record([], at(200));
    s.finalize();
    expect(s.reading().missed).toBe(1);
  });

  it("advanceTo closes an Attack whose window ended before the given time, with no Event", () => {
    // No record() and no finalize(): a checkpoint firing in a drain gap must be
    // able to settle a missed Attack on its own. See GH3-PLAN.md 6.8.
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg());
    s.advanceTo(101); // watermark past endTs, so the window has closed
    const r = s.reading();
    expect(r.missed).toBe(1);
    expect(r.caught).toBe(0);
    expect(r.rolling).toBe(0);
  });

  it("advanceTo leaves an Attack pending while its window is still open", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg());
    s.advanceTo(100); // endTs is not strictly before 100, so it stays pending
    expect(s.reading().missed).toBe(0);
    // A later Finding can still catch it, proving it was never resolved.
    s.record(one([10, 11], 100), at(100));
    expect(s.reading().caught).toBe(1);
  });

  it("advanceTo is idempotent: it counts a miss once across repeated calls", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg());
    s.advanceTo(101);
    s.advanceTo(150);
    s.advanceTo(200);
    s.finalize();
    expect(s.reading().missed).toBe(1);
  });

  it("evicts old outcomes from the rolling ring", () => {
    // Three Attacks resolve caught, missed, missed in order. A window of two keeps
    // only the last two outcomes (missed, missed), so the gauge reads 0 while the
    // global count still remembers the early catch.
    const s = createScorer(
      [
        attack(1, "a", 0, 100, [10, 11]),
        attack(2, "b", 0, 200, [20, 21]),
        attack(3, "c", 0, 300, [30, 31]),
      ],
      cfg({ window: 2 }),
    );
    s.record(one([10, 11], 50), at(50)); // caught
    s.finalize(); // b and c miss, in id order
    const r = s.reading();
    expect(r.caught).toBe(1);
    expect(r.missed).toBe(2);
    expect(r.rolling).toBe(0); // ring holds [missed, missed]
  });
});

// GH42-PLAN.md "Scoring for mixed hunts": a mixed run carries Attacks with different
// thresholds, so the scorer must read each Attack's own `threshold`, not one global
// config value.
describe("scorer (per-attack threshold, GH42 mixed hunts)", () => {
  it("credits each Attack by its own threshold, ignoring the other Attack's threshold", () => {
    // Two pending Attacks, different entities and different thresholds.
    const s = createScorer(
      [attack(1, "a", 0, 100, [10, 11], 2), attack(2, "b", 0, 100, [20, 21, 22, 23], 4)],
      cfg(),
    );
    // "a" needs only 2 distinct cited ids: its own threshold is satisfied.
    s.record(one([10, 11], 50), at(50));
    // "b" needs 4, but this Finding cites only 3 of its owned ids: below ITS OWN
    // threshold.
    s.record(one([20, 21, 22], 60), at(60));
    const r = s.reading();
    expect(r.caught).toBe(1); // only "a"
    expect(r.falseAlerts).toBe(1); // "b"'s under-threshold finding credits nothing
    expect(r.missed).toBe(0);
  });

  it("catches an Attack once its own threshold is met", () => {
    const s = createScorer([attack(1, "b", 0, 100, [20, 21, 22, 23], 4)], cfg());
    s.record(one([20, 21, 22, 23], 60), at(60)); // all 4 of its owned ids
    expect(s.reading().caught).toBe(1);
    expect(s.reading().falseAlerts).toBe(0);
  });

  it("rejects a non-positive-integer threshold at the scorer seam, naming the failure mode", () => {
    // GH42 code review: Attack.threshold is required and validated, with no
    // config-level fallback, so a bad tuning value must fail loudly here rather
    // than silently under- or over-crediting an Alert.
    const bad: Attack = {
      id: 1,
      entity: "root",
      reason: REASON,
      window: { startTs: 0, endTs: 100 },
      eventIds: [10, 11],
      threshold: 0,
    };
    expect(() => createScorer([bad], cfg())).toThrow(/threshold must be a positive integer/);
  });

  it("rejects an Attack whose distinct evidence cannot meet its threshold", () => {
    // GH42 code review: `hitsFor` dedups cited ids, so a threshold above the count
    // of DISTINCT evidence ids can never be satisfied. Repeated ids do not help: two
    // copies of id 10 are one distinct id, below a threshold of two. That must fail at
    // the scorer seam rather than silently recording a missed hunt.
    const unsatisfiable = attack(1, "root", 0, 100, [10, 10], 2);
    expect(() => createScorer([unsatisfiable], cfg())).toThrow(/distinct evidence/);
  });
});

// Seam B: the partial-skip moved from the Detect task into the scorer.
describe("scorer partial skip", () => {
  it("skips a partial finding: neither caught nor false, and no decision", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg());
    const partial: Finding = {
      alert: { reason: REASON, at: 40, eventIds: [10, 11] },
      eventId: 10,
      isPartial: true,
    };
    s.record([sf(partial)], at(50));
    expect(s.reading()).toMatchObject({ caught: 0, missed: 0, falseAlerts: 0 });
    expect(s.decisions()).toHaveLength(0);
  });

  it("still credits a later non-partial finding on the same evidence", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg());
    const partial: Finding = {
      alert: { reason: REASON, at: 40, eventIds: [10, 11] },
      eventId: 10,
      isPartial: true,
    };
    s.record([sf(partial), sf(found([10, 11], 50))], at(50));
    expect(s.reading().caught).toBe(1);
    expect(s.decisions()).toHaveLength(1);
  });
});

// Seam C: entity matching (dormant path, entityMatch on).
describe("scorer entity matching", () => {
  it("credits the attack whose entity matches, ignoring the reason", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg({ entityMatch: true }));
    // Wrong reason on purpose: only the entity should credit it.
    s.record([sf(found([10, 11], 50, "some_other_reason"), "root")], at(50));
    expect(s.reading().caught).toBe(1);
    expect(s.reading().falseAlerts).toBe(0);
  });

  it("treats a right reason but wrong entity as false (entity is authoritative)", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg({ entityMatch: true }));
    s.record([sf(found([10, 11], 50, REASON), "someone-else")], at(50));
    expect(s.reading().caught).toBe(0);
    expect(s.reading().falseAlerts).toBe(1);
  });

  it("falls back to the reason path for a finding that carries no entity", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg({ entityMatch: true }));
    s.record([sf(found([10, 11], 50, REASON))], at(50)); // no entity
    expect(s.reading().caught).toBe(1);
  });

  it("ignores the entity while entityMatch is off, using the reason path", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg()); // off
    // The entity is wrong, but off means reason decides, so it still credits.
    s.record([sf(found([10, 11], 50, REASON), "someone-else")], at(50));
    expect(s.reading().caught).toBe(1);
  });

  it("does not credit when the threshold evidence belongs to a different attack", () => {
    const s = createScorer(
      [attack(1, "root", 0, 100, [10, 11]), attack(2, "other", 0, 100, [20, 21])],
      cfg({ entityMatch: true }),
    );
    // Entity is root, but the cited evidence is owned by attack 2.
    s.record([sf(found([20, 21], 50, REASON), "root")], at(50));
    expect(s.reading().caught).toBe(0);
    expect(s.reading().falseAlerts).toBe(1);
  });

  it("credits the earlier array element when two attacks share an entity (tie-break)", () => {
    const s = createScorer(
      [attack(1, "dup", 0, 100, [10, 11]), attack(2, "dup", 0, 100, [20, 21])],
      cfg({ entityMatch: true }),
    );
    // Both attacks meet the threshold on their own evidence; the first wins.
    s.record([sf(found([10, 11, 20, 21], 50, REASON), "dup")], at(50));
    expect(asCaught(s.decisions()[0]).attackId).toBe(1);
  });

  it("resolves a promoted burst to the same entity and credits it", () => {
    const partial: Finding = {
      alert: { reason: REASON, at: 40, eventIds: [10] },
      eventId: 10,
      subjectType: "acct",
      isPartial: true,
    };
    const resolved: Finding = {
      alert: { reason: REASON, at: 50, eventIds: [10, 11] },
      eventId: 10,
      subjectType: "acct",
    };
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg({ entityMatch: true }));
    s.record([sf(partial, "root"), sf(resolved, "root")], at(50));
    expect(s.reading().caught).toBe(1);
    expect(s.decisions()).toHaveLength(1); // the partial emits none
  });
});

// Seam D: the durable decision log.
describe("scorer decisions", () => {
  it("emits a caught decision with seq, attackId, entity, and the finding", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg());
    s.record([sf(found([10, 11], 50))], at(50));
    const d = asCaught(s.decisions()[0]);
    expect(d).toMatchObject({ outcome: "caught", seq: 0, at: 50, attackId: 1, entity: "root" });
    expect(d.finding.alert).toEqual({ reason: REASON, at: 50, eventIds: [10, 11] });
  });

  it("decisionCount tracks the log length, matching decisions().length, without allocating", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg());
    expect(s.decisionCount()).toBe(0);
    s.record(one([10, 11], 50), at(50));
    expect(s.decisionCount()).toBe(1);
    expect(s.decisionCount()).toBe(s.decisions().length);
    s.record(one([99], 60), at(60)); // a second, false decision
    expect(s.decisionCount()).toBe(2);
  });

  it("carries the liveSeq of the row a caught finding upserted", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg());
    s.record([sf(found([10, 11], 50), "root")], at(50));
    const live = s.liveFindings();
    expect(live).toHaveLength(1);
    expect(asCaught(s.decisions()[0]).liveSeq).toBe(live[0]?.seq);
  });

  it("carries the liveSeq of the row a false, entity-less finding upserted", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg());
    s.record(one([99], 60), at(60)); // cites no owned evidence and names no entity
    const live = s.liveFindings();
    expect(live).toHaveLength(1);
    expect(asFalse(s.decisions()[0]).liveSeq).toBe(live[0]?.seq);
  });

  it("keeps the same liveSeq across a duplicate finding that replaces the same live row", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg());
    s.record(one([10, 11], 50), at(50)); // caught, seeds the row's seq
    s.record(one([10, 11], 60), at(60)); // a duplicate on a caught Attack scores false
    const [caught, falseDec] = s.decisions();
    expect(asFalse(falseDec).liveSeq).toBe(asCaught(caught).liveSeq); // one row, one seq
  });

  it("sources a caught decision's at from the finding, not the event", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg());
    s.record([sf(found([10, 11], 42))], at(50)); // alert.at 42, but env.ts 50
    expect(asCaught(s.decisions()[0]).at).toBe(42); // the finding's time, not the event's
  });

  it("emits a false decision carrying the finding and its entity", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg());
    s.record([sf(found([99], 60, REASON), "ghost")], at(60));
    const d = asFalse(s.decisions()[0]);
    expect(d).toMatchObject({ outcome: "false", seq: 0, at: 60, entity: "ghost" });
    expect(d.finding.alert.eventIds).toEqual([99]);
  });

  it("emits a missed decision with attackId, entity, reason, window copy, and endTs at", () => {
    const s = createScorer([attack(1, "root", 5, 100, [10, 11])], cfg());
    s.advanceTo(101);
    const d = asMissed(s.decisions()[0]);
    expect(d).toMatchObject({
      outcome: "missed",
      seq: 0,
      at: 100, // window.endTs, not the trigger time
      attackId: 1,
      entity: "root",
      reason: REASON,
      window: { startTs: 5, endTs: 100 },
    });
  });

  it("keeps seq strictly monotonic across all outcomes in append order", () => {
    const s = createScorer(
      [attack(1, "a", 0, 100, [10, 11]), attack(2, "b", 0, 300, [20, 21])],
      cfg(),
    );
    s.record([sf(found([20, 21], 50))], at(50)); // caught b (id 2)
    s.record([sf(found([99], 60))], at(60)); // false
    s.record([], at(101)); // a expires -> missed
    const seqs = s.decisions().map((d) => d.seq);
    expect(seqs).toEqual([0, 1, 2]);
  });

  it("appends in resolution order, not sorted by at (non-monotonic at, monotonic seq)", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg());
    // ts 101 closes the miss (at=100) first, then the finding (at=5) scores false.
    s.record([sf(found([99], 5))], at(101));
    const log = s.decisions();
    const outcomes: DecisionOutcome[] = log.map((d) => d.outcome);
    expect(outcomes).toEqual(["missed", "false"]);
    expect(log.map((d) => d.seq)).toEqual([0, 1]); // seq climbs
    expect(log.map((d) => d.at)).toEqual([100, 5]); // at falls: not an ordering key
  });

  it("stores an independent frozen clone of the finding in the decision", () => {
    // record() freezes its input findings in place (the live path is freeze-only), so
    // the source cannot be mutated after the call. The decision still holds its own
    // deep clone, proven here by object identity, not by mutating a now-frozen source.
    const finding: Finding = {
      alert: { reason: REASON, at: 50, eventIds: [10, 11] },
      eventId: 10,
      context: [{ type: "text" as const, text: "orig" }],
    };
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg());
    s.record([sf(finding)], at(50));
    const dec = asCaught(s.decisions()[0]);
    expect(dec.finding).not.toBe(finding); // an independent copy, not the caller's object
    expect(Object.isFrozen(dec.finding)).toBe(true);
    const stored = dec.finding.context?.[0];
    expect(stored && stored.type === "text" ? stored.text : null).toBe("orig");
  });

  it("returns a fresh frozen array of frozen decisions on every call", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg());
    s.record([sf(found([10, 11], 50))], at(50));
    const first = s.decisions();
    expect(Object.isFrozen(first)).toBe(true);
    expect(first[0] !== undefined && Object.isFrozen(first[0])).toBe(true);
    // The snapshot must freeze all the way down, not just the top level.
    const d = asCaught(first[0]);
    expect(Object.isFrozen(d.finding)).toBe(true);
    expect(Object.isFrozen(d.finding.alert)).toBe(true);
    expect(s.decisions()).not.toBe(first); // a new array each call
    expect(s.decisions()).toEqual(first); // with the same contents
  });

  it("copies the miss window, so mutating attack.window later leaves the decision intact", () => {
    const a = attack(1, "root", 0, 100, [10, 11]);
    const s = createScorer([a], cfg());
    s.advanceTo(101);
    a.window.endTs = 999; // mutate the ground-truth window after the miss
    expect(asMissed(s.decisions()[0]).window.endTs).toBe(100);
  });

  it("appends exactly one miss decision across idempotent closes", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg());
    s.advanceTo(101);
    s.advanceTo(150);
    s.finalize();
    expect(s.decisions().filter((d) => d.outcome === "missed")).toHaveLength(1);
  });

  it("emits a miss via finalize as well as via closeExpired", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg());
    s.finalize(); // no event ever closed it
    const [d] = s.decisions();
    expect(d?.outcome).toBe("missed");
  });
});

// Seam H: the live findings set, per GH28-PLAN.md.
describe("scorer liveFindings", () => {
  it("upserts a partial as a watch and a one-shot final as a hit", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg());
    const partial: Finding = {
      alert: { reason: REASON, at: 40, eventIds: [10] },
      eventId: 10,
      isPartial: true,
    };
    s.record([sf(partial), sf(found([20, 21], 50, "other_reason"))], at(50));
    const live = s.liveFindings();
    expect(live).toHaveLength(2);
    const watch = live.find((f) => f.state === "watch");
    const hit = live.find((f) => f.state === "hit");
    expect(watch?.reason).toBe(REASON);
    expect(watch?.eventIds).toEqual([10]);
    expect(hit?.reason).toBe("other_reason");
    expect(hit?.eventIds).toEqual([20, 21]);
  });

  it("promotes a watch to a hit on the same eventId+reason, keeping seq and refreshing at", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg());
    const partial: Finding = {
      alert: { reason: REASON, at: 40, eventIds: [10] },
      eventId: 10,
      isPartial: true,
    };
    s.record([sf(partial)], at(40));
    const before = s.liveFindings()[0];
    expect(before?.state).toBe("watch");
    const seq = before?.seq;

    const resolved: Finding = {
      alert: { reason: REASON, at: 50, eventIds: [10, 11] },
      eventId: 10,
    };
    s.record([sf(resolved)], at(50));
    const live = s.liveFindings();
    expect(live).toHaveLength(1); // replaced in place, not appended
    expect(live[0]?.state).toBe("hit");
    expect(live[0]?.seq).toBe(seq); // stable UI slot
    expect(live[0]?.at).toBe(50); // refreshed to the trusted env.ts
    expect(live[0]?.eventIds).toEqual([10, 11]);
  });

  it("keeps two entity-less findings that share a reason but differ in eventId as two entries", () => {
    // With no resolved entity, live identity falls back to eventId + reason, so a
    // distinct anchor never collapses onto another finding's row even when reason matches.
    const s = createScorer([attack(1, "root", 0, 300, [10, 11, 20, 21])], cfg());
    s.record([sf(found([10, 11], 50)), sf(found([20, 21], 50))], at(50));
    const live = s.liveFindings();
    expect(live).toHaveLength(2);
    expect(new Set(live.map((f) => f.seq)).size).toBe(2);
  });

  it("collapses a moved-anchor watch onto the prior hit for one entity and reason", () => {
    // Anchor stability regression: the live row is identified by (subjectType, entity,
    // reason), not the anchor. So a later watch on the same account and reason, anchored
    // on a DIFFERENT event, replaces the prior hit's row instead of seeding a second,
    // stale entry. Keyed on the anchor this would read as two rows.
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg({ liveHorizon: 1000 }));
    const hit: Finding = {
      alert: { reason: REASON, at: 50, eventIds: [10, 11] },
      eventId: 10,
      subjectType: "acct",
    };
    s.record([sf(hit, "root")], at(50));
    expect(s.liveFindings()).toHaveLength(1);
    expect(s.liveFindings()[0]?.state).toBe("hit");

    // A later watch for the same account and reason, anchored on an unowned event so the
    // zombie-watch guard keeps it, with an anchor that differs from the hit's.
    const watch: Finding = {
      alert: { reason: REASON, at: 200, eventIds: [99] },
      eventId: 99,
      subjectType: "acct",
      isPartial: true,
    };
    s.record([sf(watch, "root")], at(200));
    const live = s.liveFindings();
    expect(live).toHaveLength(1); // one row per (entity, reason), no stale hit beside it
    expect(live[0]?.state).toBe("watch");
  });

  it("ages a hit out at liveHorizon after its last emission, not the same tick it catches", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg({ liveHorizon: 20 }));
    s.record(one([10, 11], 50), at(50)); // caught
    expect(s.liveFindings()).toHaveLength(1); // still live the same tick
    s.record([], at(65)); // 65 - 50 = 15 < 20: still live
    expect(s.liveFindings()).toHaveLength(1);
    s.record([], at(70)); // 70 - 50 = 20 >= 20: ages out
    expect(s.liveFindings()).toHaveLength(0);
  });

  it("ages an orphan watch out at liveHorizon on a benign entity", () => {
    const s = createScorer([], cfg({ liveHorizon: 20 }));
    const partial: Finding = {
      alert: { reason: REASON, at: 10, eventIds: [1] },
      eventId: 1,
      isPartial: true,
    };
    s.record([sf(partial)], at(10));
    expect(s.liveFindings()).toHaveLength(1);
    s.record([], at(29)); // 19 < 20: still live
    expect(s.liveFindings()).toHaveLength(1);
    s.record([], at(30)); // 20 >= 20: ages out
    expect(s.liveFindings()).toHaveLength(0);
  });

  it("drops a watch early when its attack resolves missed", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg({ liveHorizon: 1000 }));
    const partial: Finding = {
      alert: { reason: REASON, at: 50, eventIds: [10] },
      eventId: 10,
      isPartial: true,
    };
    s.record([sf(partial)], at(50));
    expect(s.liveFindings()).toHaveLength(1);
    s.record([], at(101)); // the attack's window closes, resolving it missed
    expect(s.liveFindings()).toHaveLength(0); // dropped early, well before liveHorizon
  });

  it("does not seed a watch for a partial whose attack already resolved missed", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg({ liveHorizon: 1000 }));
    // A partial anchored on event 10 arrives at ts 200, past the attack window (ends 100).
    // record() closes the attack missed first; the late watch must not linger as a zombie.
    const partial: Finding = {
      alert: { reason: REASON, at: 200, eventIds: [10] },
      eventId: 10,
      isPartial: true,
    };
    s.record([sf(partial)], at(200));
    expect(s.liveFindings()).toHaveLength(0);
    expect(s.decisions().filter((d) => d.outcome === "missed")).toHaveLength(1);
  });

  it("does not drop a hit when an unrelated attack resolves missed", () => {
    const s = createScorer(
      [attack(1, "root", 0, 100, [10, 11]), attack(2, "other", 0, 300, [20, 21])],
      cfg({ liveHorizon: 1000 }),
    );
    s.record(one([10, 11], 50), at(50)); // catches attack 1
    expect(s.liveFindings()).toHaveLength(1);
    s.record([], at(301)); // attack 2's window closes, resolving it missed via closeExpired
    expect(s.liveFindings()).toHaveLength(1); // the caught hit survives; only its horizon evicts it
  });

  it("returns frozen entries in a fresh frozen array each call", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg());
    s.record(one([10, 11], 50), at(50));
    const first = s.liveFindings();
    expect(Object.isFrozen(first)).toBe(true);
    expect(first[0] !== undefined && Object.isFrozen(first[0])).toBe(true);
    expect(s.liveFindings()).not.toBe(first);
    expect(s.liveFindings()).toEqual(first);
  });

  it("freezes the live entry deeply, so the published snapshot cannot be mutated", () => {
    const finding: Finding = {
      alert: { reason: REASON, at: 50, eventIds: [10, 11] },
      eventId: 10,
      context: [{ type: "text" as const, text: "orig" }],
    };
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg());
    s.record([sf(finding)], at(50));
    const stored = s.liveFindings()[0];
    expect(stored !== undefined && Object.isFrozen(stored)).toBe(true);
    expect(stored !== undefined && Object.isFrozen(stored.finding)).toBe(true);
    expect(stored !== undefined && Object.isFrozen(stored.finding.alert)).toBe(true);
  });

  it("finalize clears the whole live set", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg());
    s.record(one([10, 11], 50), at(50));
    expect(s.liveFindings()).toHaveLength(1);
    s.finalize();
    expect(s.liveFindings()).toHaveLength(0);
  });

  it("carries the resolved entity when the finding names one", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg({ entityMatch: true }));
    s.record([sf(found([10, 11], 50, REASON), "root")], at(50));
    expect(s.liveFindings()[0]?.entity).toBe("root");
  });
});

/** One ring event, distinguishable by id, the shape `bindEventResolver` resolves to. */
function ringEvent(id: number): RingEvent {
  return { id, ts: id * 10, endpoint: "kiosk-v1", raw: { id }, normalized: { id } };
}

// Freeze-on-raise: a live finding's own citedEvents, accumulated (merge, never replace)
// across its emissions, so the trace resolves like a decision's does — against its own
// frozen copy, not the churning ring.
describe("scorer liveFindings citedEvents (freeze-on-raise)", () => {
  it("captures citedEvents for a raised finding via the bound resolver", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg());
    s.bindEventResolver((ids) => ids.map(ringEvent));
    s.record(one([10, 11], 50), at(50));
    expect(s.liveFindings()[0]?.citedEvents).toEqual([ringEvent(10), ringEvent(11)]);
  });

  it(
    "merges rather than replaces on re-emit: keeps a still-cited id's already-captured " +
      "event even once the resolver can no longer resolve it fresh, drops an id no longer " +
      "cited, and adds a freshly resolvable one",
    () => {
      // A resolved entity keeps the row's identity stable across emissions even though the
      // anchor (eventIds[0]) moves from 10 to 11 between them; an entity-less finding would
      // key on the anchor and fork a second row instead of upserting this one.
      const s = createScorer(
        [attack(1, "acct-1", 0, 300, [10, 11, 12])],
        cfg({ liveHorizon: 1000 }),
      );
      const citing = (eventIds: number[], ts: number): Finding => ({
        alert: { reason: REASON, at: ts, eventIds },
        eventId: eventIds[0] ?? 0,
        subjectType: "acct",
      });

      // First emission cites [10, 11]; both resolve, so the capture is exactly [10, 11].
      s.bindEventResolver((ids) => ids.filter((id) => id === 10 || id === 11).map(ringEvent));
      s.record([sf(citing([10, 11], 50), "acct-1")], at(50));
      expect(s.liveFindings()[0]?.citedEvents.map((e) => e.id)).toEqual([10, 11]);

      // Re-emit the same row citing [11, 12] (10 dropped, 12 added), while the ring has
      // moved on: the resolver now returns ONLY 12 (11 has aged out of it). A replace-only
      // implementation would give [12]; preserve-but-never-add-fresh would give [11];
      // failing to drop the no-longer-cited 10 would still include it. The merged capture
      // must be exactly [11, 12], in citation order — matching `toCards`, which iterates
      // current citation order and uses the source only as an id lookup.
      s.bindEventResolver((ids) => ids.filter((id) => id === 12).map(ringEvent));
      s.record([sf(citing([11, 12], 60), "acct-1")], at(60));
      const live = s.liveFindings();
      expect(live).toHaveLength(1); // upserted the same row, not forked
      expect(live[0]?.citedEvents.map((e) => e.id)).toEqual([11, 12]);
    },
  );

  it("leaves citedEvents empty when no resolver is bound", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg());
    s.record(one([10, 11], 50), at(50));
    expect(s.liveFindings()[0]?.citedEvents).toEqual([]);
  });

  it("freezes citedEvents with the rest of the live entry", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg());
    s.bindEventResolver((ids) => ids.map(ringEvent));
    s.record(one([10, 11], 50), at(50));
    const live = s.liveFindings()[0];
    expect(live !== undefined && Object.isFrozen(live.citedEvents)).toBe(true);
    expect(live !== undefined && Object.isFrozen(live.citedEvents[0])).toBe(true);
  });
});

// GH126-PLAN.md M2a seams 6, 7, 9, 13: the dynamic scorer seam. `addAttack`
// registers a pending attack with no evidence yet; `bindEvidence` binds owner
// ids as they arrive. Both grow the same internal attack set `scoreFinding` and
// `closeExpired` already iterate, so a dynamically added attack is scored exactly
// like a constructor-seeded one, with no new code path.
describe("scorer dynamic attacks (addAttack / bindEvidence, GH126-PLAN.md M2a)", () => {
  it("seam 6: credits a finding whose attack was registered, then had its evidence bound, reproducing the real offer order", () => {
    const s = createScorer([], cfg());
    s.addAttack({
      attackId: 1,
      entity: "wave-victim",
      reason: REASON,
      threshold: 2,
      windowEnd: 100,
    });
    s.bindEvidence(1, 10);
    s.bindEvidence(1, 11);
    s.record(one([10, 11], 50), at(50));
    expect(s.reading()).toMatchObject({ caught: 1, missed: 0, falseAlerts: 0 });
  });

  it("seam 6: a finding citing unbound ids scores false, not caught, until bindEvidence runs", () => {
    const s = createScorer([], cfg());
    s.addAttack({
      attackId: 1,
      entity: "wave-victim",
      reason: REASON,
      threshold: 2,
      windowEnd: 100,
    });
    s.record(one([10, 11], 50), at(50)); // no bindEvidence yet
    expect(s.reading()).toMatchObject({ caught: 0, falseAlerts: 1 });
  });

  it("seam 6: bindEvidence throws for an unregistered attack id", () => {
    const s = createScorer([], cfg());
    expect(() => s.bindEvidence(999, 10)).toThrow(/not registered/);
  });

  it("seam 7: addAttack throws on a duplicate attack id", () => {
    const s = createScorer([], cfg());
    s.addAttack({ attackId: 1, entity: "a", reason: REASON, threshold: 2, windowEnd: 100 });
    expect(() =>
      s.addAttack({ attackId: 1, entity: "b", reason: REASON, threshold: 2, windowEnd: 200 }),
    ).toThrow(/already registered/);
  });

  it("seam 7: two waves' attacks stay distinct, each crediting its own finding", () => {
    const s = createScorer([], cfg());
    s.addAttack({ attackId: 1, entity: "wave-1", reason: REASON, threshold: 2, windowEnd: 100 });
    s.addAttack({ attackId: 2, entity: "wave-2", reason: REASON, threshold: 2, windowEnd: 200 });
    s.bindEvidence(1, 10);
    s.bindEvidence(1, 11);
    s.bindEvidence(2, 20);
    s.bindEvidence(2, 21);
    s.record(one([10, 11], 50), at(50));
    s.record(one([20, 21], 60), at(60));
    expect(s.reading()).toMatchObject({ caught: 2, missed: 0, falseAlerts: 0 });
  });

  it("seam 9: advanceTo resolves a pending added attack as missed only once its window passes", () => {
    const s = createScorer([], cfg());
    s.addAttack({
      attackId: 1,
      entity: "wave-victim",
      reason: REASON,
      threshold: 2,
      windowEnd: 100,
    });
    s.advanceTo(100); // not strictly past endTs yet: stays pending
    expect(s.reading().missed).toBe(0);
    s.advanceTo(101); // past endTs now: resolves missed
    expect(s.reading().missed).toBe(1);
  });

  it("seam 9: bound evidence still catches an added attack right up to its window's close", () => {
    const s = createScorer([], cfg());
    s.addAttack({
      attackId: 1,
      entity: "wave-victim",
      reason: REASON,
      threshold: 2,
      windowEnd: 100,
    });
    s.bindEvidence(1, 10);
    s.bindEvidence(1, 11);
    s.record(one([10, 11], 100), at(100)); // exactly at endTs: not expired yet
    expect(s.reading()).toMatchObject({ caught: 1, missed: 0 });
  });

  it("seam 13: addAttack rejects a non-positive or non-integer threshold", () => {
    const s = createScorer([], cfg());
    expect(() =>
      s.addAttack({ attackId: 1, entity: "a", reason: REASON, threshold: 0, windowEnd: 100 }),
    ).toThrow(/threshold must be a positive integer/);
    expect(() =>
      s.addAttack({ attackId: 2, entity: "a", reason: REASON, threshold: 1.5, windowEnd: 100 }),
    ).toThrow(/threshold must be a positive integer/);
  });

  it("addAttack runs no distinct-evidence-vs-threshold check: a high threshold with zero evidence never throws at registration", () => {
    const s = createScorer([], cfg());
    expect(() =>
      s.addAttack({ attackId: 1, entity: "a", reason: REASON, threshold: 5, windowEnd: 100 }),
    ).not.toThrow();
  });
});

// Seam I (T10, GH34-35-PLAN.md 2.1): cited-event capture, resolvedAt, and the capped log.
describe("scorer citedEvents, resolvedAt, and the capped log", () => {
  it("captures citedEvents for a caught decision via the bound resolver", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg());
    s.bindEventResolver((ids) => ids.map(ringEvent));
    s.record(one([10, 11], 50), at(50));
    expect(asCaught(s.decisions()[0]).citedEvents).toEqual([ringEvent(10), ringEvent(11)]);
  });

  it("captures citedEvents for a false decision via the bound resolver", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg());
    s.bindEventResolver((ids) => ids.map(ringEvent));
    s.record(one([99], 50), at(50)); // cites an id no Attack owns
    expect(asFalse(s.decisions()[0]).citedEvents).toEqual([ringEvent(99)]);
  });

  it("leaves citedEvents empty when no resolver is bound", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg());
    s.record(one([10, 11], 50), at(50));
    expect(asCaught(s.decisions()[0]).citedEvents).toEqual([]);
  });

  it("omits ids the resolver could not resolve (evicted from the ring)", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg());
    // Only id 10 resolves; 11 has aged out of the ring, mirroring the live trace.
    s.bindEventResolver((ids) => ids.filter((id) => id === 10).map(ringEvent));
    s.record(one([10, 11], 50), at(50));
    expect(asCaught(s.decisions()[0]).citedEvents).toEqual([ringEvent(10)]);
  });

  it("freezes citedEvents with the rest of the decision", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg());
    s.bindEventResolver((ids) => ids.map(ringEvent));
    s.record(one([10, 11], 50), at(50));
    const decision = asCaught(s.decisions()[0]);
    expect(Object.isFrozen(decision.citedEvents)).toBe(true);
    expect(Object.isFrozen(decision.citedEvents[0])).toBe(true);
  });

  it("drops the oldest decisions past decisionsCap, while reading() counts stay exact", () => {
    const s = createScorer([], cfg({ decisionsCap: 2 }));
    s.record(one([90], 10), at(10)); // false #1
    s.record(one([91], 20), at(20)); // false #2
    s.record(one([92], 30), at(30)); // false #3, evicts #1 from the log
    expect(s.decisions()).toHaveLength(2);
    expect(s.decisions().map((d) => asFalse(d).finding.alert.eventIds[0])).toEqual([91, 92]);
    // reading() folds every outcome that ever resolved, unaffected by the log's cap.
    expect(s.reading().falseAlerts).toBe(3);
  });

  it("keeps seq unique and strictly monotonic across appends once the cap engages", () => {
    const s = createScorer([], cfg({ decisionsCap: 2 }));
    for (let i = 0; i < 5; i++) {
      s.record(one([90 + i], i * 10), at(i * 10));
    }
    const seqs = s.decisions().map((d) => d.seq);
    expect(seqs).toEqual([3, 4]); // the last two of a strictly climbing 0..4, no reuse
  });

  it("keeps decisions() seq-ordered once the cap has dropped earlier entries", () => {
    const s = createScorer([], cfg({ decisionsCap: 3 }));
    for (let i = 0; i < 6; i++) {
      s.record(one([90 + i], i * 10), at(i * 10));
    }
    const seqs = s.decisions().map((d) => d.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it("keeps decisionsCap unbounded by default, preserving today's behavior", () => {
    const s = createScorer([], cfg());
    for (let i = 0; i < 10; i++) {
      s.record(one([90 + i], i * 10), at(i * 10));
    }
    expect(s.decisions()).toHaveLength(10);
  });

  it("resolvedAt is the trusted env.ts, diverging from a lying alert.at", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg());
    // The finding's own alert.at lies (999); env.ts (the real record() time) is 50.
    const lying = found([10, 11], 999);
    s.record([sf(lying)], at(50));
    const d = asCaught(s.decisions()[0]);
    expect(d.resolvedAt).toBe(50);
    expect(d.at).toBe(999); // at stays the (untrusted) display metadata
    expect(d.resolvedAt).not.toBe(d.at);
  });

  it("a false decision's resolvedAt is also the trusted env.ts", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg());
    const lying = found([99], 999);
    s.record([sf(lying)], at(50));
    expect(asFalse(s.decisions()[0]).resolvedAt).toBe(50);
  });

  it("a closeExpired() miss carries resolvedAt === attack.window.endTs", () => {
    const s = createScorer([attack(1, "root", 5, 100, [10, 11])], cfg());
    s.record([], at(101)); // watermark passes endTs: closeExpired resolves the miss
    const d = asMissed(s.decisions()[0]);
    expect(d.resolvedAt).toBe(100);
    expect(d.resolvedAt).toBe(d.at);
  });

  it("a finalize() miss carries resolvedAt === attack.window.endTs", () => {
    const s = createScorer([attack(1, "root", 5, 100, [10, 11])], cfg());
    s.finalize(); // no Event ever closed it
    const d = asMissed(s.decisions()[0]);
    expect(d.resolvedAt).toBe(100);
  });
});
