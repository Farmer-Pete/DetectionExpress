/**
 * The profiler entry: it binds the pure measurement pieces to the environment.
 * It applies the defer guard first (a hidden tab or a missing clock blocks the
 * reading), then calibrates over the default corpus with the real timing
 * protocol. Every environment input is injectable, so the whole flow is tested
 * with no live worker and no DOM.
 *
 * The corpus, config, and timer default to the shipped tuning and a
 * `performance.now` clock, but a test passes its own. See GH3-PLAN.md 6.5 and 7.
 */
import {
  CORPUS_PEAK_EVENTS_PER_TICK,
  CORPUS_SIZE,
  LEVEL_SEED,
  PROFILE_BATCH_MS,
  PROFILE_BATCHES,
  PROFILE_WARMUP_MS,
} from "../tuning";
import { type CalibrationResult, calibrate, type ProfilerRule } from "./calibrate";
import { buildCorpus, type Corpus } from "./corpus";
import { hasHighResTimer, type MeasurementBlock, measurementBlock, tabHidden } from "./guard";
import type { MeasureConfig, Timer } from "./measure";

/** A completed reading, or a deferral with the reason it was blocked. */
export type ProfileOutcome =
  | { ok: true; result: CalibrationResult }
  | { ok: false; deferred: MeasurementBlock };

/** What the environment supplies. All optional; production reads the real values. */
export interface ProfileOptions {
  hidden?: boolean;
  hasTimer?: boolean;
  corpus?: Corpus;
  timer?: Timer;
  config?: MeasureConfig;
}

/** The shipped measurement protocol config, from the tuning constants. */
function defaultProfileConfig(): MeasureConfig {
  return { warmupMs: PROFILE_WARMUP_MS, batchMs: PROFILE_BATCH_MS, batches: PROFILE_BATCHES };
}

/** The shipped calibration corpus, from the level seed at peak density. */
export function buildDefaultCorpus(): Corpus {
  return buildCorpus(LEVEL_SEED, CORPUS_SIZE, CORPUS_PEAK_EVENTS_PER_TICK);
}

/** A timer backed by the real high-resolution clock. Profiler glue, not sim. */
export function performanceTimer(): Timer {
  return { now: () => performance.now() };
}

/**
 * Spawn the profiler Web Worker. The pure profiling logic runs off the main
 * thread; the worker shell (worker.ts) posts back a ProfileOutcome. The M2
 * run-controller owns this worker's lifecycle (spawn per generation, terminate a
 * stale one); M1 only needs the seam so the worker file is a real entry.
 */
export function spawnProfilerWorker(): Worker {
  return new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
}

/**
 * Profile `rule`. Defers if the guard blocks; otherwise measures over the corpus
 * and returns codePerAnchor and oracleScore.
 */
export function profile(rule: ProfilerRule, options: ProfileOptions = {}): ProfileOutcome {
  const hidden = options.hidden ?? tabHidden();
  const hasTimer = options.hasTimer ?? hasHighResTimer();
  const block = measurementBlock(hidden, hasTimer);
  if (block !== null) {
    return { ok: false, deferred: block };
  }
  const corpus = options.corpus ?? buildDefaultCorpus();
  const timer = options.timer ?? performanceTimer();
  const config = options.config ?? defaultProfileConfig();
  return { ok: true, result: calibrate(rule, corpus, config, timer) };
}
