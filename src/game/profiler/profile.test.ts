import { describe, expect, it } from "vitest";
import { CORPUS_PEAK_EVENTS_PER_TICK, LEVEL_SEED } from "../tuning";
import type { ProfilerRule } from "./calibrate";
import { buildCorpus } from "./corpus";
import type { Timer } from "./measure";
import { profile, spawnProfilerWorker } from "./profile";
import { makeNaiveScan, type NormalizedKiosk, normalizeKiosk } from "./rules";

/**
 * The profiler entry ties the pure pieces to the environment: it applies the
 * defer guard first, then calibrates over the default corpus with the real timing
 * protocol. Everything the environment supplies is injectable, so this is tested
 * without a live worker or a DOM. See GH3-PLAN.md sections 6.5 and 7.
 */
function naiveRule(): ProfilerRule<NormalizedKiosk> {
  const detector = makeNaiveScan();
  return { normalize: normalizeKiosk, detect: (view) => detector.step(view) };
}

function steppingTimer(step: number): Timer {
  let t = -step;
  return {
    now: () => {
      t += step;
      return t;
    },
  };
}

describe("profile", () => {
  it("defers while the tab is hidden, without measuring", () => {
    const outcome = profile(naiveRule(), { hidden: true, hasTimer: true });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.deferred).toBe("hidden");
    }
  });

  it("defers when no high-resolution timer exists", () => {
    const outcome = profile(naiveRule(), { hidden: false, hasTimer: false });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.deferred).toBe("no-timer");
    }
  });

  it("measures a finite, positive reading when visible and clocked", () => {
    const corpus = buildCorpus(LEVEL_SEED, 100, CORPUS_PEAK_EVENTS_PER_TICK);
    const outcome = profile(naiveRule(), {
      hidden: false,
      hasTimer: true,
      corpus,
      timer: steppingTimer(10),
      config: { warmupMs: 10, batchMs: 10, batches: 1 },
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(Number.isFinite(outcome.result.codePerAnchor)).toBe(true);
      expect(outcome.result.codePerAnchor).toBeGreaterThan(0);
      expect(outcome.result.oracleScore).toBeGreaterThan(0);
    }
  });

  it("exposes a worker spawn seam for the M2 run-controller", () => {
    // The seam is asserted as callable, not invoked: spawning a real Worker needs
    // a browser. This keeps worker.ts a referenced entry without a live worker.
    expect(spawnProfilerWorker).toBeInstanceOf(Function);
  });
});
