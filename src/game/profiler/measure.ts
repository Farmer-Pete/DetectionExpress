/**
 * The measurement protocol, as pure logic over an injected timer. It warms up
 * (discarding the cold-JIT stretch), then times a fixed number of batches, each
 * of at least a minimum duration, and takes the median throughput so one noisy
 * batch cannot swing the reading.
 *
 * The timer is injected: production passes `performance.now`, tests pass a fake
 * that returns scripted per-call readings. So the batch, warm-up, and median
 * logic is exercised with no wall-clock. This module never reads real time
 * itself, which keeps it inside the sim's no-wall-clock discipline even though it
 * lives in game glue.
 */

/** The slice of a clock the protocol needs: monotonic milliseconds. */
export interface Timer {
  now(): number;
}

/** The protocol's knobs: the warm-up and batch floors, and the batch count. */
export interface MeasureConfig {
  warmupMs: number;
  batchMs: number;
  batches: number;
}

/** One timed batch: how many iterations ran, over how long, and the throughput. */
export interface Batch {
  iterations: number;
  elapsedMs: number;
  throughput: number;
}

/** The median of a non-empty set. Even lengths average the two middle values. */
export function median(values: number[]): number {
  if (values.length === 0) {
    throw new RangeError("median of an empty set is undefined");
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) {
    return sorted[mid] ?? 0;
  }
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/**
 * Run `runOnce` repeatedly until the timer has advanced at least `minMs`, then
 * report the iteration count, the elapsed time, and iterations per millisecond.
 * At least one iteration always runs, and `minMs` must be positive, so the
 * elapsed time is never zero and the throughput is always finite.
 */
export function timeBatch(runOnce: () => void, timer: Timer, minMs: number): Batch {
  const start = timer.now();
  let iterations = 0;
  let elapsed = 0;
  do {
    runOnce();
    iterations++;
    elapsed = timer.now() - start;
  } while (elapsed < minMs);
  return { iterations, elapsedMs: elapsed, throughput: iterations / elapsed };
}

/**
 * Warm up for `warmupMs` (discarded), then time `batches` batches of at least
 * `batchMs` each and return the median throughput, in iterations per millisecond.
 */
export function measureThroughput(
  runOnce: () => void,
  timer: Timer,
  config: MeasureConfig,
): number {
  timeBatch(runOnce, timer, config.warmupMs); // warm the JIT, discard the reading
  const throughputs: number[] = [];
  for (let i = 0; i < config.batches; i++) {
    throughputs.push(timeBatch(runOnce, timer, config.batchMs).throughput);
  }
  return median(throughputs);
}
