/**
 * Rate math as pure functions. Rates are counted in Events per tick, then turned
 * into Events per second and smoothed with an exponential moving average. No
 * real time is read, so a stall or a pause cannot inflate a rate.
 */

/** Turn a per-sample count delta over `ticks` into events per second. */
export function perSecond(deltaCount: number, ticks: number, clockHz: number): number {
  return ticks > 0 ? (deltaCount * clockHz) / ticks : 0;
}

/** The EMA smoothing factor for a time constant `tau` at `hz` samples/sec. */
export function emaAlpha(tau: number, hz: number): number {
  return 1 - Math.exp(-1 / (tau * hz));
}

/** One EMA step: move `prev` toward `sample` by `alpha`. */
export function ema(prev: number, sample: number, alpha: number): number {
  return prev + (sample - prev) * alpha;
}
