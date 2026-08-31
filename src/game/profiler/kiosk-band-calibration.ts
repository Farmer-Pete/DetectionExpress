/**
 * The kiosk cost model and the two locked reference service rates
 * (issue #89). Every kiosk-specific number the winnability band
 * needs lives here: the counted-cost model that prices the naive raw-log scan
 * against the incremental tally, the resulting code-per-anchor multipliers, and
 * the rate helper that turns a multiplier into the real quantized `ServiceRate`
 * the governor charges.
 *
 * `REFERENCE_SLOW_RATE` and `REFERENCE_FAST_RATE` are the two yardsticks both the
 * kiosk winnability test and the fare-gate throughput test squeeze against: the
 * naive rule's rate at the shipped OMEGA (about 20 events/tick) and the tally
 * rule's rate at the same OMEGA. Since GH102 the corpus is burst-shaped (co-located
 * patron/attacker pairs), so the fail share is emergent, not tuned; the tally rate
 * rises with it (about 798 events/tick) because the naive scan's window fill grows.
 */

import type { ServiceRate } from "../../sim/service-governor";
import {
  CORPUS_ACCOUNTS,
  CORPUS_PEAK_EVENTS_PER_TICK,
  OMEGA,
  PIN_BRUTE_FORCE_THRESHOLD,
  SCAN_WINDOW_TICKS,
} from "../tuning";
import { quantizeServiceRate } from "./quantize";

/**
 * The expected wrong-PIN fail share of the SHIPPED (sliced) corpus (GH102 D10). Two
 * derived parts. The pair mean: each co-located pair emits one success and a uniform
 * 5..8-fail burst, so mean fails per pair is `PIN_BRUTE_FORCE_THRESHOLD + 1.5` and
 * the full-stream share is `meanFails / (meanFails + 1)`, about 0.867. The slice
 * offset: bursts trail their success, so `buildCorpus`'s cut of the sorted stream to
 * the first `size` events removes a mostly-fail time-tail (measured ~94% fails
 * across seeds), lowering the KEPT share by about 0.02. The constant subtracts that
 * measured structural offset so it describes the corpus the profiler actually
 * prices; a 3-seed corpus test pins the measured share to within 0.01 of this.
 */
const MEAN_FAILS_PER_PAIR = PIN_BRUTE_FORCE_THRESHOLD + 1.5;
/** The measured drop from the pair-mean share caused by the fail-heavy tail cut. */
const SLICE_TAIL_OFFSET = 0.02;
export const EXPECTED_CORPUS_FAIL_SHARE =
  MEAN_FAILS_PER_PAIR / (MEAN_FAILS_PER_PAIR + 1) - SLICE_TAIL_OFFSET;

// The naive scan re-filters an account's in-window fails on every fail, so its
// per-Event cost grows with the window fill. The tally is amortized O(1). The
// anchor is the naive scan priced at the corpus density, so codePerAnchor is 1
// for the naive rule and the cost ratio for the tally. The overhead and per-op
// constants only shift the ratio slightly; the skew band absorbs that slack.
const OVERHEAD = 2; // per-Event dispatch and normalize, in element-visit units
const TALLY_OP = 3; // enqueue, expiry drain, and count update, amortized

/** Fails an account holds in the detection window at `density` Events per tick. */
function windowFill(density: number): number {
  return (density * EXPECTED_CORPUS_FAIL_SHARE * SCAN_WINDOW_TICKS) / CORPUS_ACCOUNTS;
}

/** The naive scan's counted cost per Event at `density`: overhead plus the scan. */
export function naiveCost(density: number): number {
  return OVERHEAD + EXPECTED_CORPUS_FAIL_SHARE * windowFill(density);
}

/** The tally's counted cost per Event: overhead plus O(1) bookkeeping. Density-independent. */
function tallyCost(): number {
  return OVERHEAD + EXPECTED_CORPUS_FAIL_SHARE * TALLY_OP;
}

/** The anchor cost: the naive scan priced at the corpus peak density. */
const ANCHOR_COST = naiveCost(CORPUS_PEAK_EVENTS_PER_TICK);

/** codePerAnchor for the naive rule: the anchor cost over its own cost, always 1. */
export const NAIVE_CODE_PER_ANCHOR = ANCHOR_COST / naiveCost(CORPUS_PEAK_EVENTS_PER_TICK);

/** codePerAnchor for the tally rule: the anchor cost over its cost, the separation ratio R. */
export const TALLY_CODE_PER_ANCHOR = ANCHOR_COST / tallyCost();

/** Turn a code speed, a difficulty dial, and a skew into the real quantized rate. */
export function rateFor(codePerAnchor: number, omega: number, skew: number): ServiceRate {
  return quantizeServiceRate(codePerAnchor * omega * skew);
}

/** The naive rule's rate at the shipped OMEGA, skew 1: about 20 events per tick. */
export const REFERENCE_SLOW_RATE: ServiceRate = rateFor(NAIVE_CODE_PER_ANCHOR, OMEGA, 1);

/** The tally rule's rate at the shipped OMEGA, skew 1: about 798 events per tick. */
export const REFERENCE_FAST_RATE: ServiceRate = rateFor(TALLY_CODE_PER_ANCHOR, OMEGA, 1);
