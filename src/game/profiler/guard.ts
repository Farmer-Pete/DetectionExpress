/**
 * The measurement guard. The profiler's readings are only meaningful when its
 * timers run, so this decides whether to take a reading now or defer. Two things
 * block it: no high-resolution clock at all, and a hidden tab (whose worker clock
 * is throttled). A machine speeding up or slowing down is not a block, because
 * that cancels in the C/A ratio. So the guard never rejects on speed.
 *
 * The decision is pure over two booleans, so it is unit-tested without a DOM. The
 * thin readers below sample the real environment on the main thread.
 */

/** Why a reading is blocked, or null when it may proceed. */
export type MeasurementBlock = "hidden" | "no-timer";

/** Decide whether to defer a reading. `null` means take it now. */
export function measurementBlock(hidden: boolean, hasTimer: boolean): MeasurementBlock | null {
  if (!hasTimer) {
    return "no-timer";
  }
  if (hidden) {
    return "hidden";
  }
  return null;
}

/** True when a high-resolution `performance.now` clock is available. */
export function hasHighResTimer(): boolean {
  return globalThis.performance?.now instanceof Function;
}

/** True when the tab is hidden. Absent a `document` (a worker), treat as visible. */
export function tabHidden(): boolean {
  return globalThis.document?.hidden === true;
}
