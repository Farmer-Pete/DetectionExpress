/**
 * The profiler orchestration. It times three throughputs over the looping corpus
 * with one measurement protocol and one injected timer:
 *
 * - C = events/playerMs: the player's match on the flat view, the same view the
 *   Match task builds at run time.
 * - A = events/anchorMs: the frozen detection-shaped anchor.
 * - O: the oracle's raw integer speed, kept only as profiler health.
 *
 * It returns codePerAnchor = C/A (= anchorMs/playerMs), the machine-independent
 * code speed the service governor consumes, and oracleScore = O. All wall-clock
 * enters through the injected timer, so this stays testable and the sim loop
 * never sees real time. See GH3-PLAN.md sections 5.1, 6.5, and 7.
 */

import type { Alert } from "../../sim/alert";
import type { RawKioskV1 } from "../../sim/endpoints/kiosk/formats/kiosk-v1";
import { makeAnchor } from "./anchor";
import { type Corpus, loopingCorpus } from "./corpus";
import { type MeasureConfig, measureThroughput, type Timer } from "./measure";
import { ORACLE_ROUNDS, oracleChecksum } from "./oracle";
import { type MatchView, type NormalizedKiosk, normalizeKiosk } from "./rules";

/** A rule the profiler prices: normalize a raw payload, then match the flat view. */
export interface ProfilerRule {
  normalize(raw: RawKioskV1): NormalizedKiosk;
  match(view: MatchView): Alert | null;
}

/** The profiler's reading: the code speed and the machine-health probe. */
export interface CalibrationResult {
  /** C/A = anchorMs/playerMs, the machine-independent code speed. */
  codePerAnchor: number;
  /** O, the oracle throughput, profiler health only. */
  oracleScore: number;
}

/** The measurement protocol, injectable so tests can stub the timing. */
export type MeasureFn = (runOnce: () => void, timer: Timer, config: MeasureConfig) => number;

/** Build the flat match view the run-time Match task hands a rule. */
function viewOf(normalized: NormalizedKiosk, id: number, ts: number, endpoint: string): MatchView {
  return {
    account: normalized.account,
    terminal: normalized.terminal,
    outcome: normalized.outcome,
    id,
    ts,
    endpoint,
  };
}

/**
 * Measure `rule` over `corpus` and return codePerAnchor and oracleScore. Each of
 * the three throughputs gets its own corpus iterator, so the player and the
 * anchor see the same stream and the readings are comparable. A running sink
 * consumes every result, so the JIT cannot elide the timed work.
 */
export function calibrate(
  rule: ProfilerRule,
  corpus: Corpus,
  config: MeasureConfig,
  timer: Timer,
  measure: MeasureFn = measureThroughput,
): CalibrationResult {
  let sink = 0;

  const playerNext = loopingCorpus(corpus);
  const runPlayer = (): void => {
    const event = playerNext();
    const view = viewOf(rule.normalize(event.payload), event.id, event.ts, event.endpoint);
    sink += rule.match(view) === null ? 0 : 1;
  };

  const anchorNext = loopingCorpus(corpus);
  const anchor = makeAnchor();
  const runAnchor = (): void => {
    const event = anchorNext();
    const view = viewOf(normalizeKiosk(event.payload), event.id, event.ts, event.endpoint);
    sink += anchor(view);
  };

  let oracleSeed = 0;
  const runOracle = (): void => {
    oracleSeed = (oracleSeed + 1) | 0;
    sink += oracleChecksum(oracleSeed, ORACLE_ROUNDS);
  };

  const c = measure(runPlayer, timer, config);
  const a = measure(runAnchor, timer, config);
  const o = measure(runOracle, timer, config);

  if (!Number.isFinite(sink)) {
    throw new Error("profiler sink went non-finite"); // also forces the sink to be read
  }
  return { codePerAnchor: c / a, oracleScore: o };
}
