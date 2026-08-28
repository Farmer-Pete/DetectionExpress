import { describe, expect, it } from "bun:test";
import { measureThroughput, median, type Timer, timeBatch } from "./measure";

/**
 * The measurement protocol's pure core: warm up, then time batches and take the
 * median throughput. A fake timer returns scripted per-call readings, so the
 * warm-up discard and the median selection are checked on known inputs with no
 * wall-clock. See GH3-PLAN.md section 9, M1 seam 2 (the timing half).
 */

/** A timer that returns each reading in turn, holding the last one afterward. */
function scriptedTimer(readings: number[]): Timer {
  let i = 0;
  return {
    now: () => readings[i++] ?? readings[readings.length - 1] ?? 0,
  };
}

/**
 * Build the reading sequence for a run of batches. Each batch reports `start`,
 * then one reading per iteration, the last landing exactly on `ms` so the batch
 * ends after exactly `iters` iterations. Times accumulate so the stream is
 * monotonic, the way a real clock is.
 */
function scriptBatches(specs: Array<{ iters: number; ms: number }>): number[] {
  const readings: number[] = [];
  let base = 0;
  for (const spec of specs) {
    readings.push(base);
    for (let i = 1; i <= spec.iters; i++) {
      readings.push(base + (i * spec.ms) / spec.iters);
    }
    base += spec.ms;
  }
  return readings;
}

describe("median", () => {
  it("takes the middle of an odd-length set, order-independent", () => {
    expect(median([0.3, 0.06, 0.14, 0.1, 0.2])).toBeCloseTo(0.14, 12);
  });

  it("averages the two middle values of an even-length set", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("throws on an empty set", () => {
    expect(() => median([])).toThrow();
  });
});

describe("timeBatch", () => {
  it("runs until the timer reaches the minimum and reports the throughput", () => {
    let calls = 0;
    const timer = scriptedTimer([0, 10, 20, 30, 40, 50]);
    const batch = timeBatch(
      () => {
        calls++;
      },
      timer,
      50,
    );
    expect(batch.iterations).toBe(5);
    expect(batch.elapsedMs).toBe(50);
    expect(batch.throughput).toBeCloseTo(0.1, 12);
    expect(calls).toBe(5);
  });
});

describe("measureThroughput", () => {
  it("discards the warm-up batch and returns the median of the timed batches", () => {
    // Warm-up runs 100 iterations (throughput 2.0). If it leaked into the median
    // it would dominate, so a correct discard leaves the median at 7/50 = 0.14.
    const timer = scriptedTimer(
      scriptBatches([
        { iters: 100, ms: 50 }, // warm-up, discarded
        { iters: 5, ms: 50 }, // 0.10
        { iters: 10, ms: 50 }, // 0.20
        { iters: 3, ms: 50 }, // 0.06
        { iters: 15, ms: 50 }, // 0.30
        { iters: 7, ms: 50 }, // 0.14  <- median
      ]),
    );
    const throughput = measureThroughput(() => {}, timer, {
      warmupMs: 50,
      batchMs: 50,
      batches: 5,
    });
    expect(throughput).toBeCloseTo(0.14, 12);
  });
});
