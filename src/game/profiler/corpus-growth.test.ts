import { describe, expect, it } from "vitest";
import { CORPUS_PEAK_EVENTS_PER_TICK, CORPUS_SIZE, LEVEL_SEED } from "../tuning";
import { buildCorpus, loopingCorpus } from "./corpus";
import { makeNaiveScan, normalizeKiosk } from "./rules";

/**
 * M3 seam 13: the naive scan's cost grows with volume. It re-filters an account's
 * in-window fails on every fail, so its per-Event work climbs with the window fill,
 * which climbs with the corpus density. That rising cost is the whole reason the
 * profiler prices it slow at peak and the player must optimize. See GH3-PLAN.md
 * sections 6.5 and 9 (M3 seam 13).
 *
 * Work is measured as the retained fail count folded over the wrap, the same proxy
 * the bounded-corpus test uses: retained size is what the naive scan re-filters, so
 * a heavier retained trace is a heavier per-Event work trace.
 */

/**
 * The naive scan's steady-state work over one wrap at `density`: loop the corpus
 * until the window is full, then fold the retained count over every Event of the
 * last wrap. Reuses the profiler corpus machinery unchanged.
 */
function steadyWork(density: number): number {
  const corpus = buildCorpus(LEVEL_SEED, CORPUS_SIZE, density);
  const next = loopingCorpus(corpus);
  const detector = makeNaiveScan();
  let work = 0;
  for (let wrap = 0; wrap < 6; wrap++) {
    work = 0;
    for (let i = 0; i < CORPUS_SIZE; i++) {
      const event = next();
      detector.step({
        ...normalizeKiosk(event.payload),
        id: event.id,
        ts: event.ts,
        endpoint: event.endpoint,
      });
      work += detector.retained();
    }
  }
  return work;
}

describe("naive scan corpus growth (M3 seam 13)", () => {
  const LOW_DENSITY = 2;
  const GROWTH_FACTOR = 3; // "at least several times" its cost at the start

  it("costs several times more at peak density than at low density", () => {
    const low = steadyWork(LOW_DENSITY);
    const peak = steadyWork(CORPUS_PEAK_EVENTS_PER_TICK);
    expect(low).toBeGreaterThan(0);
    expect(peak).toBeGreaterThanOrEqual(GROWTH_FACTOR * low);
  });

  it("climbs monotonically as the density rises", () => {
    const densities = [2, 4, 8, CORPUS_PEAK_EVENTS_PER_TICK];
    const work = densities.map(steadyWork);
    for (let i = 1; i < work.length; i++) {
      expect(work[i] ?? 0).toBeGreaterThan(work[i - 1] ?? 0);
    }
  });
});
