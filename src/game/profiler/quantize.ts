/**
 * Quantize a measured float service rate into a reduced rational the integer
 * service governor charges without float drift. The governor (M2) advances an
 * integer accumulator by `den` per Event and sleeps while it holds `num`, so the
 * total sleep after N Events is exactly `floor(N * den / num)`. That only stays
 * exact while both parts are safe integers, so the value is rounded onto a fixed
 * denominator, reduced by its gcd, and clamped below the safe-integer bound.
 *
 * Pure and deterministic. No wall-clock, no allocation beyond the returned pair.
 */
import { OMEGA, SERVICE_DEN } from "../tuning";

/** Records per tick as a reduced rational. Both parts are positive safe integers. */
export interface ServiceRate {
  num: number;
  den: number;
}

/** Greatest common divisor by Euclid's algorithm, on non-negative integers. */
function gcd(a: number, b: number): number {
  let x = a;
  let y = b;
  while (y !== 0) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x;
}

/**
 * Turn `value` records per tick into a reduced rational. `value` must be finite
 * and strictly positive. `num` is rounded onto `SERVICE_DEN`, floored up to one
 * so a tiny rate never quantizes to zero, and clamped so `num <= MAX_SAFE_INTEGER
 * - den` before the gcd reduction (the reduction only widens that margin).
 */
export function quantizeServiceRate(value: number): ServiceRate {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`serviceRate must be finite and positive, got ${value}`);
  }
  const den = SERVICE_DEN;
  const cap = Number.MAX_SAFE_INTEGER - den;
  let num = Math.round(value * den);
  if (num < 1) {
    num = 1;
  } else if (num > cap) {
    num = cap;
  }
  const divisor = gcd(num, den);
  return { num: num / divisor, den: den / divisor };
}

/**
 * Turn a machine-independent code speed (codePerAnchor = C/A) into the service
 * rate the governor charges: `serviceRate = (C/A) * OMEGA`, records per tick,
 * quantized. OMEGA is the difficulty dial. M2 wires this into the run; M1 builds
 * and unit-tests it. See GH3-PLAN.md sections 5.2 and 8.
 */
export function serviceRateForCode(codePerAnchor: number): ServiceRate {
  return quantizeServiceRate(codePerAnchor * OMEGA);
}
