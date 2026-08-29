import { describe, expect, it } from "vitest";
import { CORPUS_PEAK_EVENTS_PER_TICK, LEVEL_SEED } from "../tuning";
import { calibrate, type ProfilerRule } from "./calibrate";
import { buildCorpus } from "./corpus";
import type { Timer } from "./measure";
import { makeNaiveScan, type NormalizedKiosk, normalizeKiosk } from "./rules";

/**
 * The profiler orchestration: warm, measure the player's detect throughput C, the
 * anchor A, and the oracle O over the looping corpus, and return codePerAnchor =
 * C/A and oracleScore = O. The composition (which reading divides which) is pinned
 * with a stub measure; the real timing path is covered by the harness, not CI.
 * See GH3-PLAN.md sections 5.1 and 6.5.
 */

/** A rule the profiler prices: the shared normalize plus a detector's step. */
function naiveRule(): ProfilerRule<NormalizedKiosk> {
  const detector = makeNaiveScan();
  return { normalize: normalizeKiosk, detect: (view) => detector.step(view) };
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

  it("prices a rule that returns an array of Alerts without throwing (M2 review)", () => {
    const corpus = buildCorpus(LEVEL_SEED, 100, CORPUS_PEAK_EVENTS_PER_TICK);
    // A rule whose detect returns Finding[] runs fine in the run-time Detect task;
    // the profiler must price it the same way rather than rejecting the array.
    const arrayRule: ProfilerRule<NormalizedKiosk> = {
      normalize: normalizeKiosk,
      detect: (v) =>
        v.outcome === "fail"
          ? [{ alert: { reason: "pin_brute_force", at: v.ts, eventIds: [v.id] } }]
          : [],
    };
    // If the profiler rejected arrays it would throw here; reaching a finite
    // reading is the assertion that it prices the array shape like the runtime.
    const result = calibrate(
      arrayRule,
      corpus,
      { warmupMs: 10, batchMs: 10, batches: 1 },
      steppingTimer(10),
    );
    expect(Number.isFinite(result.codePerAnchor)).toBe(true);
  });
});
