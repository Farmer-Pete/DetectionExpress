/**
 * The anchor: the profiler's difficulty baseline. It is a fixed array-and-garbage
 * scan over the corpus, the same shape as the naive rule (per-account recent
 * fails, re-filtered on each fail). Timing it gives A = events/anchorMs, the
 * machine's throughput on detection-shaped work. The player's C is divided by A
 * to get the machine-independent C/A, so array-heavy code is priced fairly.
 *
 * It is frozen on purpose: it must not track whatever rule ships, or the
 * difficulty would move with the default. Pure, deterministic, game-time only.
 */

import type { MatchView } from "./rules";
import { SCAN_WINDOW_S } from "./rules";

/** One retained fail the anchor scan keeps in the window. */
interface AnchorRecord {
  id: number;
  ts: number;
}

/**
 * Build one anchor scanner. Each call processes one view: a fail appends to the
 * account's array, re-filters it to the window, and folds the kept length into a
 * running checksum. The checksum is returned so the work is consumed and the JIT
 * cannot elide it. Successes do no work, so only detection-shaped cost is timed.
 */
export function makeAnchor(): (view: MatchView) => number {
  const recent = new Map<string, AnchorRecord[]>();
  let checksum = 0;
  return (view: MatchView): number => {
    if (view.outcome === "fail") {
      const arr = recent.get(view.account) ?? [];
      arr.push({ id: view.id, ts: view.ts });
      const kept = arr.filter((record) => record.ts > view.ts - SCAN_WINDOW_S);
      recent.set(view.account, kept);
      checksum = (checksum + kept.length) | 0;
    }
    return checksum;
  };
}
