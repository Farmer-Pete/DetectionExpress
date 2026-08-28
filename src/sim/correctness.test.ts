import { describe, expect, it } from "bun:test";
import type { Alert } from "./alert";
import type { Attack } from "./attack";
import { type Counts, createScorer, type ScorerConfig, score } from "./correctness";
import type { PipeEvent } from "./event";

const REASON = "pin_brute_force";

function counts(caught: number, missed: number, falseAlerts: number): Counts {
  return { caught, missed, falseAlerts };
}

function attack(
  id: number,
  account: string,
  startTs: number,
  endTs: number,
  eventIds: number[],
): Attack {
  return { id, account, reason: REASON, window: { startTs, endTs }, eventIds };
}

/** A bare Event carrying only the scheduled time the scorer folds on. */
function at(ts: number): PipeEvent {
  return { id: 0, ts, endpoint: "kiosk-v1", payload: null };
}

function alert(events: number[], ts: number, reason = REASON): Alert {
  return { reason, at: ts, events };
}

function cfg(over: Partial<ScorerConfig> = {}): ScorerConfig {
  return { threshold: 2, window: 40, wFn: 3, wFp: 1, ...over };
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

describe("scorer", () => {
  it("credits one pending Attack whose reason matches and evidence suffices", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg());
    s.record(alert([10, 11], 50), at(50));
    s.finalize();
    expect(s.reading()).toEqual({ rolling: 100, caught: 1, missed: 0, falseAlerts: 0 });
  });

  it("misses an Attack whose window closes with no Alert", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg());
    s.record(null, at(101)); // watermark passes endTs, so the window has closed
    const r = s.reading();
    expect(r.missed).toBe(1);
    expect(r.caught).toBe(0);
    expect(r.rolling).toBe(0); // 100 * 0 / (0 + 3)
  });

  it("counts an Alert that credits no Attack as a false alert", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg());
    s.record(alert([99, 98], 50), at(50)); // cites ids no Attack owns
    expect(s.reading().falseAlerts).toBe(1);
    expect(s.reading().caught).toBe(0);
  });

  it("needs the threshold of DISTINCT cited ids; repeats do not qualify", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg({ threshold: 2 }));
    s.record(alert([10, 10, 10], 50), at(50)); // one distinct id, threshold is two
    expect(s.reading().falseAlerts).toBe(1);
    expect(s.reading().caught).toBe(0);
  });

  it("treats a too-little-evidence Alert as false", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11, 12])], cfg({ threshold: 3 }));
    s.record(alert([10, 11], 50), at(50)); // two of three, below threshold
    expect(s.reading().falseAlerts).toBe(1);
    expect(s.reading().caught).toBe(0);
  });

  it("treats a duplicate Alert on a caught Attack as false", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg());
    s.record(alert([10, 11], 50), at(50));
    s.record(alert([10, 11], 60), at(60));
    expect(s.reading().caught).toBe(1);
    expect(s.reading().falseAlerts).toBe(1);
  });

  it("closes an expired Attack before scoring the same Event's Alert", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg());
    // The Event's ts is past endTs, so the Attack closes as a miss, and the late
    // Alert riding the same Event finds it resolved and scores as a false alert.
    s.record(alert([10, 11], 101), at(101));
    const r = s.reading();
    expect(r.missed).toBe(1);
    expect(r.falseAlerts).toBe(1);
    expect(r.caught).toBe(0);
  });

  it("still credits an Alert on an Event exactly at endTs", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg());
    s.record(alert([10, 11], 100), at(100));
    expect(s.reading().caught).toBe(1);
    expect(s.reading().missed).toBe(0);
  });

  it("finalize closes every remaining pending Attack as a miss", () => {
    const s = createScorer(
      [attack(1, "a", 0, 100, [10, 11]), attack(2, "b", 0, 200, [20, 21])],
      cfg(),
    );
    s.record(alert([10, 11], 50), at(50)); // catch the first
    s.finalize(); // the second never fired
    const r = s.reading();
    expect(r.caught).toBe(1);
    expect(r.missed).toBe(1);
  });

  it("counts a miss once even as later Events keep folding in", () => {
    const s = createScorer([attack(1, "root", 0, 100, [10, 11])], cfg());
    s.record(null, at(101)); // expires here
    s.record(null, at(150));
    s.record(null, at(200));
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
    // A later Alert can still catch it, proving it was never resolved.
    s.record(alert([10, 11], 100), at(100));
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
    s.record(alert([10, 11], 50), at(50)); // caught
    s.finalize(); // b and c miss, in id order
    const r = s.reading();
    expect(r.caught).toBe(1);
    expect(r.missed).toBe(2);
    expect(r.rolling).toBe(0); // ring holds [missed, missed]
  });
});
