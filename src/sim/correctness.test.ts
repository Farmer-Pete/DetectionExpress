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

const REASON = "pin_brute_force";

function counts(caught: number, missed: number, falseAlerts: number): Counts {
  return { caught, missed, falseAlerts };
}

function attack(
  id: number,
  entity: string,
  startTs: number,
  endTs: number,
  eventIds: number[],
): Attack {
  return { id, entity, reason: REASON, window: { startTs, endTs }, eventIds };
}

/** A bare Event carrying only the scheduled time the scorer folds on. */
function at(ts: number): PipeEvent {
  return { id: 0, ts, endpoint: "kiosk-v1", payload: null };
}

/** A resolved (non-partial) one-shot finding citing the given evidence. */
function found(eventIds: number[], ts: number, reason = REASON): Finding {
  return { alert: { reason, at: ts, eventIds } };
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
  return { threshold: 2, window: 40, wFn: 3, wFp: 1, ...over };
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
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg({ threshold: 2 }));
    s.record(one([10, 10, 10], 50), at(50)); // one distinct id, threshold is two
    expect(s.reading().falseAlerts).toBe(1);
    expect(s.reading().caught).toBe(0);
  });

  it("treats a too-little-evidence Finding as false", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11, 12])], cfg({ threshold: 3 }));
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

  it("clones the finding, so mutating the source after record leaves the decision intact", () => {
    const widget = { type: "text" as const, text: "orig" };
    const finding: Finding = {
      alert: { reason: REASON, at: 50, eventIds: [10, 11] },
      context: [widget],
    };
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg());
    s.record([sf(finding)], at(50));
    widget.text = "changed"; // mutate the source after recording
    const stored = asCaught(s.decisions()[0]).finding.context?.[0];
    expect(stored && stored.type === "text" ? stored.text : null).toBe("orig");
  });

  it("returns a fresh frozen array of frozen decisions on every call", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg());
    s.record([sf(found([10, 11], 50))], at(50));
    const first = s.decisions();
    expect(Object.isFrozen(first)).toBe(true);
    expect(first[0] !== undefined && Object.isFrozen(first[0])).toBe(true);
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
