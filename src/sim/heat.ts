/**
 * Heat math as pure functions. A node's color comes from how full its input
 * buffer is (occupancy), ramped over samples. Occupancy, not a rate deficit,
 * because blocking backpressure settles the pipeline at the bottleneck's rate,
 * so a rate deficit goes to zero while the buffer stays full.
 */

/** Input occupancy: buffered items over capacity. A source has no input, so 0. */
export function occupancy(size: number, cap: number): number {
  return cap > 0 ? size / cap : 0;
}

/**
 * One heat step. Above the threshold heat ramps up by `rampStep` toward 1; at or
 * below it cools down by `coolStep` toward 0. A brief fill stays cool; sustained
 * fill turns red.
 */
export function nextHeat(
  heat: number,
  occ: number,
  threshold: number,
  rampStep: number,
  coolStep: number,
): number {
  const congested = occ > threshold;
  return congested ? Math.min(1, heat + rampStep) : Math.max(0, heat - coolStep);
}
