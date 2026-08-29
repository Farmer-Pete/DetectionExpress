/**
 * The service governor: the integer accumulator that charges a rule's run-time
 * cost as whole Clock ticks, with no float drift. The Detect task charges one
 * Event at a time; the governor decides how many ticks to sleep before the next.
 *
 * `serviceRate = num/den` records per tick (positive safe integers). Each Event
 * adds `den` to the accumulator and sleeps one tick for every whole `num` it now
 * holds. The invariant `0 <= acc < num` between Events keeps `acc + den` inside a
 * safe integer, so the total slept after N Events is exactly
 * `floor(N * den / num) = floor(N / serviceRate)`. Pure and deterministic;
 * game-time ticks only, no wall-clock. See GH3-PLAN.md section 5.2.
 */

/** Records per tick as a reduced rational. Both parts are positive safe integers. */
export interface ServiceRate {
  num: number;
  den: number;
}

/** Charges one Event's service. `charge` returns the whole ticks to sleep next. */
export interface ServiceGovernor {
  charge(): number;
}

/**
 * Build a governor for `rate`. Rejects a non-finite, non-positive, non-integer, or
 * unsafe rate up front, so a bad service rate fails loudly before the run instead
 * of drifting silently during it.
 */
export function makeGovernor(rate: ServiceRate): ServiceGovernor {
  const { num, den } = rate;
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || num < 1 || den < 1) {
    throw new RangeError(`serviceRate must be positive safe integers, got num=${num}, den=${den}`);
  }
  if (num > Number.MAX_SAFE_INTEGER - den) {
    throw new RangeError(`serviceRate numerator ${num} risks overflow past the safe-integer bound`);
  }
  let acc = 0;
  return {
    charge() {
      acc += den;
      // Integer division gives the same whole-tick count as draining `num` in a
      // loop, in constant time. `acc + den` stays within the safe-integer bound
      // (checked at build), so `floor(acc / num)` is exact and the invariant
      // `0 <= acc < num` holds after the subtraction.
      const ticks = Math.floor(acc / num);
      acc -= ticks * num;
      return ticks;
    },
  };
}
