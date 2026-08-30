/**
 * The kiosk cost model and the two locked reference service rates
 * (GH89-PLAN.md section 8.2). Every kiosk-specific number the winnability band
 * needs lives here: the counted-cost model that prices the naive raw-log scan
 * against the incremental tally, the resulting code-per-anchor multipliers, and
 * the rate helper that turns a multiplier into the real quantized `ServiceRate`
 * the governor charges.
 *
 * `REFERENCE_SLOW_RATE` and `REFERENCE_FAST_RATE` are the two yardsticks both the
 * kiosk winnability test and the fare-gate throughput test squeeze against: the
 * naive rule's rate at the shipped OMEGA (about 20 events/tick) and the tally
 * rule's rate at the same OMEGA (about 368 events/tick).
 */

import type { ServiceRate } from "../../sim/service-governor";
import {
  CORPUS_ACCOUNTS,
  CORPUS_FAIL_SHARE,
  CORPUS_PEAK_EVENTS_PER_TICK,
  OMEGA,
  SCAN_WINDOW_TICKS,
} from "../tuning";
import { quantizeServiceRate } from "./quantize";

// The naive scan re-filters an account's in-window fails on every fail, so its
// per-Event cost grows with the window fill. The tally is amortized O(1). The
// anchor is the naive scan priced at the corpus density, so codePerAnchor is 1
// for the naive rule and the cost ratio for the tally. The overhead and per-op
// constants only shift the ratio slightly; the skew band absorbs that slack.
const OVERHEAD = 2; // per-Event dispatch and normalize, in element-visit units
const TALLY_OP = 3; // enqueue, expiry drain, and count update, amortized

/** Fails an account holds in the detection window at `density` Events per tick. */
function windowFill(density: number): number {
  return (density * CORPUS_FAIL_SHARE * SCAN_WINDOW_TICKS) / CORPUS_ACCOUNTS;
}

/** The naive scan's counted cost per Event at `density`: overhead plus the scan. */
export function naiveCost(density: number): number {
  return OVERHEAD + CORPUS_FAIL_SHARE * windowFill(density);
}

/** The tally's counted cost per Event: overhead plus O(1) bookkeeping. Density-independent. */
function tallyCost(): number {
  return OVERHEAD + CORPUS_FAIL_SHARE * TALLY_OP;
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

/** The tally rule's rate at the shipped OMEGA, skew 1: about 368 events per tick. */
export const REFERENCE_FAST_RATE: ServiceRate = rateFor(TALLY_CODE_PER_ANCHOR, OMEGA, 1);
