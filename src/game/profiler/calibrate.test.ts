import { describe, expect, it } from "bun:test";
import { CORPUS_PEAK_EVENTS_PER_TICK, LEVEL_SEED } from "../tuning";
import { calibrate, type ProfilerRule } from "./calibrate";
import { buildCorpus } from "./corpus";
import type { Timer } from "./measure";
import { makeNaiveScan, normalizeKiosk } from "./rules";

/**
 * The profiler orchestration: warm, measure the player's match throughput C, the
 * anchor A, and the oracle O over the looping corpus, and return codePerAnchor =
 * C/A and oracleScore = O. The composition (which reading divides which) is pinned
 * with a stub measure; the real timing path is covered by the harness, not CI.
 * See GH3-PLAN.md sections 5.1 and 6.5.
 */

/** A rule the profiler prices: the shared normalize plus a detector's step. */
function naiveRule(): ProfilerRule {
  const detector = makeNaiveScan();
  return { normalize: normalizeKiosk, match: (view) => detector.step(view) };
}

/** A timer that advances a fixed step on every read, so batches end deterministically. */
function steppingTimer(step: number): Timer {
  let t = -step;
  return {
    now: () => {
      t += step;
      return t;
    },
  };
}

describe("calibrate", () => {
  it("returns codePerAnchor = C/A and oracleScore = O", () => {
    const corpus = buildCorpus(LEVEL_SEED, 100, CORPUS_PEAK_EVENTS_PER_TICK);
    const throughputs = [12, 4, 30]; // C, A, O in call order
    let call = 0;
    const stubMeasure = (): number => throughputs[call++] ?? 0;
    const result = calibrate(
      naiveRule(),
      corpus,
      { warmupMs: 1, batchMs: 1, batches: 1 },
      steppingTimer(1),
      stubMeasure,
    );
    expect(result.codePerAnchor).toBeCloseTo(12 / 4, 12);
    expect(result.oracleScore).toBe(30);
  });

  it("runs the real protocol to a finite, positive reading", () => {
    const corpus = buildCorpus(LEVEL_SEED, 100, CORPUS_PEAK_EVENTS_PER_TICK);
    const result = calibrate(
      naiveRule(),
      corpus,
      { warmupMs: 10, batchMs: 10, batches: 1 },
      steppingTimer(10),
    );
    expect(Number.isFinite(result.codePerAnchor)).toBe(true);
    expect(result.codePerAnchor).toBeGreaterThan(0);
    expect(result.oracleScore).toBeGreaterThan(0);
  });
});
