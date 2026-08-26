/**
 * The simulation core. Pure TypeScript, no React and no DOM.
 * The Engine, Events, and the tick loop land here from Slice 0 onward.
 * Keeping this headless lets the sim run deterministically in tests and CI.
 */

/** One tick of Backlog: work that arrived, minus work the Engine cleared. Never negative. */
export function nextBacklog(current: number, arrived: number, cleared: number): number {
  return Math.max(0, current + arrived - cleared);
}
