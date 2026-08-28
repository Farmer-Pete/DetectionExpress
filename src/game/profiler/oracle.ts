/**
 * The oracle: a fixed integer kernel that characterizes the machine's raw speed,
 * independent of the player's code. Its timed throughput (O) is the profiler's
 * health signal, used only to spot a throttled tab or a bad reading, never to set
 * difficulty. The kernel is deterministic to the bit, so its checksum is stable
 * across runs and a change to it means a real regression.
 *
 * Pure and allocation-free: it mixes 32-bit integers with xorshift and Math.imul
 * and folds them into one running checksum. No arrays, no objects, no wall-clock.
 */

/** The rounds of mixing one oracle call runs. Sets the work per timed iteration. */
export const ORACLE_ROUNDS = 2048;

/** A round constant that de-correlates the fold from the xorshift stream. */
const FOLD_ODD = 0x9e3779b1;

/** A fixed salt so a zero seed still enters the mixing with set bits. */
const ORACLE_SALT = 0x2545f491;

/**
 * One xorshift32 step: a bijection on the non-zero 32-bit integers. Returns a
 * signed 32-bit result; callers fold it, so the sign is irrelevant.
 */
export function xorshift32(state: number): number {
  let x = state | 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return x | 0;
}

/**
 * Run `rounds` of mixing from `seed` and return the folded checksum as an
 * unsigned 32-bit integer. Zero rounds returns the identity checksum (0), so the
 * output tracks the work actually done.
 */
export function oracleChecksum(seed: number, rounds: number): number {
  let state = (seed | 0) ^ ORACLE_SALT;
  let checksum = 0;
  for (let i = 0; i < rounds; i++) {
    state = xorshift32(state);
    checksum = (Math.imul(checksum ^ state, FOLD_ODD) + 1) | 0;
  }
  return checksum >>> 0;
}
