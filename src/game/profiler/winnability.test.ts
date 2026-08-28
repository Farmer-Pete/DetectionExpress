import { describe, expect, it } from "bun:test";
import { buildSchedule } from "../../sim/scenarios/kiosk-pin-attack/scenario";
import { makeGovernor, type ServiceRate } from "../../sim/service-governor";
import {
  CHANNEL_CAP,
  CORPUS_ACCOUNTS,
  CORPUS_FAIL_SHARE,
  CORPUS_PEAK_EVENTS_PER_TICK,
  OMEGA,
  SCAN_WINDOW_TICKS,
  WAVE_RATES,
} from "../tuning";
import { quantizeServiceRate } from "./quantize";

/**
 * The abstract-cost winnability band test (M2 seam 9). Pure, deterministic, no
 * wall-clock. It prices the two rules with a counted-cost model grounded in their
 * algorithmic complexity, turns each price into the real quantized service rate,
 * and runs both through the real governor sleep math and a faithful integer model
 * of the Channel backpressure. Across a band of OMEGA and a resource-skew factor,
 * the naive raw-log scan must fail a checkpoint with margin and the incremental
 * tally must clear every one with margin. This is what locks OMEGA and the wave
 * rates. See GH3-PLAN.md sections 8, 9 (M2 seam 9), and 11.
 */

// --- The counted-cost model -------------------------------------------------
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
function naiveCost(density: number): number {
  return OVERHEAD + CORPUS_FAIL_SHARE * windowFill(density);
}

/** The tally's counted cost per Event: overhead plus O(1) bookkeeping. */
const TALLY_COST = OVERHEAD + CORPUS_FAIL_SHARE * TALLY_OP;

/** The anchor cost: the naive scan priced at the corpus peak density. */
const ANCHOR_COST = naiveCost(CORPUS_PEAK_EVENTS_PER_TICK);

/** codePerAnchor for each rule: the anchor cost over the rule's own cost. */
const NAIVE_CODE_PER_ANCHOR = ANCHOR_COST / naiveCost(CORPUS_PEAK_EVENTS_PER_TICK); // == 1
const TALLY_CODE_PER_ANCHOR = ANCHOR_COST / TALLY_COST; // the separation ratio R

/** Turn a code speed, a difficulty dial, and a skew into the real quantized rate. */
function rateFor(codePerAnchor: number, omega: number, skew: number): ServiceRate {
  return quantizeServiceRate(codePerAnchor * omega * skew);
}

// --- The abstract pipeline ---------------------------------------------------
// A faithful integer model of the run: arrivals follow the wave schedule; the
// Match node completes Events at the real governor's rate; a backpressure ceiling
// of 2 * CHANNEL_CAP caps how far admitted may lead completed, exactly as the two
// bounded upstream Channels do (the Match->Sink Channel stays near empty). The
// checkpoint is read at the start-of-tick boundary, before that tick's service,
// so an Event completing on the checkpoint tick counts as still outstanding.

interface SimResult {
  outcome: "won" | "failed";
  failedCheckpoint: number; // index, or -1 on a win
  backlogAtFailure: number;
  maxBacklog: number;
}

/** Events arriving at each tick, from the wave schedule's carried accumulator. */
function arrivalsByTick(deadline: number): number[] {
  const arrivals = new Array<number>(deadline + 1).fill(0);
  for (const wave of buildSchedule().waves) {
    let acc = 0;
    const end = wave.startTick + wave.durationTicks;
    for (let tick = wave.startTick; tick < end && tick <= deadline; tick++) {
      acc += wave.eventsPerTick;
      while (acc >= 1) {
        acc -= 1;
        arrivals[tick] = (arrivals[tick] ?? 0) + 1;
      }
    }
  }
  return arrivals;
}

function simulate(rate: ServiceRate): SimResult {
  const { checkpoints } = buildSchedule();
  const deadline = checkpoints[checkpoints.length - 1]?.atTick ?? 0;
  const arrivals = arrivalsByTick(deadline);
  const governor = makeGovernor(rate);
  const ceiling = 2 * CHANNEL_CAP;

  let scheduledCum = 0;
  let admitted = 0;
  let completed = 0;
  let matchFreeAt = 1; // the next tick Match may pull, given its governor sleeps
  let maxBacklog = 0;
  let nextCheckpoint = 0;

  for (let tick = 1; tick <= deadline; tick++) {
    // Start-of-tick checkpoint evaluation, before this tick's arrivals and service.
    while (nextCheckpoint < checkpoints.length) {
      const cp = checkpoints[nextCheckpoint];
      if (!cp || cp.atTick > tick) {
        break;
      }
      const backlog = admitted - completed;
      const isFinal = nextCheckpoint === checkpoints.length - 1;
      if (backlog !== 0) {
        return {
          outcome: "failed",
          failedCheckpoint: nextCheckpoint,
          backlogAtFailure: backlog,
          maxBacklog,
        };
      }
      if (isFinal) {
        return { outcome: "won", failedCheckpoint: -1, backlogAtFailure: 0, maxBacklog };
      }
      nextCheckpoint += 1;
    }

    // Admit this tick's arrivals, held back by the backpressure ceiling.
    scheduledCum += arrivals[tick] ?? 0;
    admitted = Math.min(scheduledCum, completed + ceiling);

    // Serve as many Events as the governor allows this tick.
    while (tick >= matchFreeAt && admitted > completed) {
      const sleep = governor.charge();
      completed += 1;
      admitted = Math.min(scheduledCum, completed + ceiling);
      if (sleep > 0) {
        matchFreeAt = tick + sleep; // busy through the sleep, resuming later
        break;
      }
    }
    maxBacklog = Math.max(maxBacklog, admitted - completed);
  }

  const remaining = admitted - completed;
  return {
    outcome: remaining === 0 ? "won" : "failed",
    failedCheckpoint: remaining === 0 ? -1 : checkpoints.length - 1,
    backlogAtFailure: remaining,
    maxBacklog,
  };
}

// The skew band: the player's measured code speed can deviate from the anchor by
// up to this factor (phone vs desktop, section 11). The naive claim is hardest
// when the player's naive code runs this much FASTER than nominal; the tally
// claim is hardest when it runs this much SLOWER.
const SKEW_BAND = [1, 1.3, 1.6, 2];
// OMEGA band around the shipped value. Every entry stays under peak / skewMax, so
// even the fastest naive reading drowns, and over peak * skewMax / R, so even the
// slowest tally clears.
const OMEGA_BAND = [15, 18, OMEGA];

const PEAK = WAVE_RATES[WAVE_RATES.length - 1] ?? 0;

describe("winnability cost model", () => {
  it("prices the naive scan at one anchor and the tally far cheaper", () => {
    expect(NAIVE_CODE_PER_ANCHOR).toBe(1);
    // The window scan dwarfs the O(1) tally, so the separation ratio is large.
    expect(TALLY_CODE_PER_ANCHOR).toBeGreaterThan(10);
  });
});

describe("winnability at the shipped tuning (nominal, skew 1)", () => {
  const naiveRate = rateFor(NAIVE_CODE_PER_ANCHOR, OMEGA, 1);
  const tallyRate = rateFor(TALLY_CODE_PER_ANCHOR, OMEGA, 1);

  it("sits the naive rate between the Wave 2 and Wave 3 arrival", () => {
    const naive = naiveRate.num / naiveRate.den;
    expect(naive).toBeGreaterThan(WAVE_RATES[WAVE_RATES.length - 2] ?? 0); // above Wave 2
    expect(naive).toBeLessThan(PEAK); // below the peak
  });

  it("sits the tally rate well above the peak", () => {
    const tally = tallyRate.num / tallyRate.den;
    expect(tally).toBeGreaterThan(PEAK * 2); // clears the peak with margin
  });

  it("drowns the naive rule at the final deadline, with the Backlog at the ceiling", () => {
    const result = simulate(naiveRate);
    expect(result.outcome).toBe("failed");
    expect(result.failedCheckpoint).toBe(buildSchedule().checkpoints.length - 1); // the final deadline
    expect(result.backlogAtFailure).toBeGreaterThanOrEqual(CHANNEL_CAP); // a full, unambiguous fail
  });

  it("carries the tally rule through every checkpoint with Backlog headroom", () => {
    const result = simulate(tallyRate);
    expect(result.outcome).toBe("won");
    expect(result.maxBacklog).toBeLessThanOrEqual(CHANNEL_CAP); // never near the ceiling
  });
});

describe("winnability across the OMEGA and skew band (M2 seam 9)", () => {
  it("drowns the naive rule with margin even when its code runs faster than the anchor", () => {
    for (const omega of OMEGA_BAND) {
      for (const skew of SKEW_BAND) {
        const result = simulate(rateFor(NAIVE_CODE_PER_ANCHOR, omega, skew));
        expect(result.outcome).toBe("failed");
        expect(result.backlogAtFailure).toBeGreaterThanOrEqual(CHANNEL_CAP);
      }
    }
  });

  it("clears the tally rule with margin even when its code runs slower than the anchor", () => {
    for (const omega of OMEGA_BAND) {
      for (const skew of SKEW_BAND) {
        const result = simulate(rateFor(TALLY_CODE_PER_ANCHOR, omega, 1 / skew));
        expect(result.outcome).toBe("won");
        expect(result.maxBacklog).toBeLessThanOrEqual(CHANNEL_CAP);
      }
    }
  });
});
