import { describe, expect, it } from "bun:test";
import {
  CORPUS_PEAK_EVENTS_PER_TICK,
  CORPUS_SIZE,
  GAME_SECONDS_PER_TICK,
  LEVEL_SEED,
} from "../tuning";
import { buildCorpus, loopingCorpus } from "./corpus";
import {
  type Detector,
  makeIncrementalTally,
  makeNaiveScan,
  normalizeKiosk,
  SCAN_WINDOW_S,
} from "./rules";

/**
 * M1 seam 3: over the looping, ts-and-id-advancing corpus, both rules keep their
 * retained state bounded by one window and settle into a steady state, so no
 * per-batch module reload is needed. Retained size drives the naive scan's filter
 * cost, so a flat retained trace across wraps is a flat per-wrap work trace.
 * See GH3-PLAN.md sections 6.5 and 9.
 */

/** The most fails a single window can hold: worst case, every corpus Event fails. */
const eventsPerSecond = CORPUS_PEAK_EVENTS_PER_TICK / GAME_SECONDS_PER_TICK;
const MAX_FAILS_IN_WINDOW = SCAN_WINDOW_S * eventsPerSecond;

/**
 * Run `wraps` full passes over the looping corpus through `detector`, sampling the
 * retained count at each wrap boundary and summing it across every Event as a
 * per-wrap work proxy.
 */
function runWraps(
  detector: Detector,
  wraps: number,
): { retainedAtWrapEnd: number[]; workPerWrap: number[] } {
  const corpus = buildCorpus(LEVEL_SEED, CORPUS_SIZE, CORPUS_PEAK_EVENTS_PER_TICK);
  const next = loopingCorpus(corpus);
  const retainedAtWrapEnd: number[] = [];
  const workPerWrap: number[] = [];
  for (let wrap = 0; wrap < wraps; wrap++) {
    let work = 0;
    for (let i = 0; i < CORPUS_SIZE; i++) {
      const event = next();
      const view = {
        ...normalizeKiosk(event.payload),
        id: event.id,
        ts: event.ts,
        endpoint: event.endpoint,
      };
      detector.step(view);
      work += detector.retained();
    }
    retainedAtWrapEnd.push(detector.retained());
    workPerWrap.push(work);
  }
  return { retainedAtWrapEnd, workPerWrap };
}

describe.each([
  ["naive scan", makeNaiveScan],
  ["incremental tally", makeIncrementalTally],
])("%s over the looping corpus", (_name, make) => {
  it("keeps retained state bounded by one window", () => {
    const { retainedAtWrapEnd } = runWraps(make(), 8);
    for (const retained of retainedAtWrapEnd) {
      expect(retained).toBeLessThanOrEqual(MAX_FAILS_IN_WINDOW);
    }
  });

  it("keeps the detection window an integer multiple of the corpus span", () => {
    // The exact-equality steady state below holds only when each wrap replays an
    // identical window. Name that precondition so a ratio-breaking tuning change
    // fails here instead of in the opaque equality assertions.
    const spanSeconds = Math.ceil(CORPUS_SIZE / eventsPerSecond);
    expect(SCAN_WINDOW_S % spanSeconds).toBe(0);
  });

  it("settles: retained and per-wrap work are flat once the window is full", () => {
    // The window (300 s) spans about three corpus wraps (~100 s each), so state is
    // steady well before the sixth wrap. The last three wraps must match exactly.
    const { retainedAtWrapEnd, workPerWrap } = runWraps(make(), 8);
    expect(retainedAtWrapEnd[5]).toBe(retainedAtWrapEnd[6] ?? -1);
    expect(retainedAtWrapEnd[6]).toBe(retainedAtWrapEnd[7] ?? -1);
    expect(workPerWrap[5]).toBe(workPerWrap[6] ?? -1);
    expect(workPerWrap[6]).toBe(workPerWrap[7] ?? -1);
  });

  it("actually retains something, so the bound is a real steady state", () => {
    const { retainedAtWrapEnd } = runWraps(make(), 8);
    expect(retainedAtWrapEnd[7] ?? 0).toBeGreaterThan(0);
  });
});
