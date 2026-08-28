/**
 * The two detection rules the profiler prices, in the same shape the M2 game runs
 * them. Both catch the kiosk PIN brute force (threshold failures on one account
 * inside the window) and both raise one Alert per burst, so the profiler is
 * timing the same detector at two speeds:
 *
 * - The naive scan keeps a per-account array of recent fails and re-filters it on
 *   every fail. Its work grows with the fails in the window, so it measures slow
 *   at peak density. It evicts past the window, so its state stays bounded.
 * - The incremental tally keeps a global expiry queue and per-account counts,
 *   amortized O(1) per Event. It assumes in-order time, which is the seed the M3
 *   slice later exploits. Its state is also bounded by one window.
 *
 * Pure, deterministic, game-time only. No wall-clock, no ground-truth access.
 */
import type { Alert } from "../../sim/alert";
import type { RawKioskV1 } from "../../sim/endpoints/kiosk/formats/kiosk-v1";
import { PIN_BRUTE_FORCE_REASON } from "../../sim/scenarios/kiosk-pin-attack/attacks";
import { GAME_SECONDS_PER_TICK, PIN_BRUTE_FORCE_THRESHOLD, SCAN_WINDOW_TICKS } from "../tuning";

/** The reason the kiosk PIN brute-force Alert names. Shared with the scorer. */
const REASON = PIN_BRUTE_FORCE_REASON;

/** The detection window in game seconds. The rules keep only fails newer than this. */
export const SCAN_WINDOW_S = SCAN_WINDOW_TICKS * GAME_SECONDS_PER_TICK;

const THRESHOLD = PIN_BRUTE_FORCE_THRESHOLD;

/** The player's shape after Normalize. */
export interface NormalizedKiosk {
  account: string;
  terminal: string;
  outcome: "success" | "fail";
}

/** The flat view a Match rule reads: the normalized payload plus engine fields. */
export interface MatchView extends NormalizedKiosk {
  id: number;
  ts: number;
  endpoint: string;
}

/**
 * A detection rule as the profiler drives it: one step per Event, plus the count
 * of Events it is retaining. The retained count is the observable memory bound;
 * the profiler's bounded-corpus test asserts it stays within one window.
 */
export interface Detector {
  step(event: MatchView): Alert | null;
  retained(): number;
}

/** Re-spell one raw kiosk-v1 payload into the normalized domain shape. */
export function normalizeKiosk(raw: RawKioskV1): NormalizedKiosk {
  return {
    account: raw.acct,
    terminal: raw.term,
    outcome: raw.res === "WRONG_PIN" ? "fail" : "success",
  };
}

/** One retained fail: its id and time. */
interface FailRecord {
  id: number;
  ts: number;
}

/**
 * The naive raw-log scan. On every fail it appends to the account's array and
 * re-filters the whole array to the window, so the per-Event cost grows with the
 * window's fail count. Fires on the rising edge and holds until the count drops.
 */
export function makeNaiveScan(): Detector {
  const fails = new Map<string, FailRecord[]>();
  const firing = new Set<string>();
  return {
    step(event: MatchView): Alert | null {
      if (event.outcome !== "fail") {
        return null;
      }
      const arr = fails.get(event.account) ?? [];
      arr.push({ id: event.id, ts: event.ts });
      const kept = arr.filter((record) => record.ts > event.ts - SCAN_WINDOW_S);
      fails.set(event.account, kept);
      if (kept.length < THRESHOLD) {
        firing.delete(event.account);
        return null;
      }
      if (firing.has(event.account)) {
        return null;
      }
      firing.add(event.account);
      return { reason: REASON, at: event.ts, events: kept.map((record) => record.id) };
    },
    retained(): number {
      let total = 0;
      for (const arr of fails.values()) {
        total += arr.length;
      }
      return total;
    },
  };
}

/** One queued fail in the global expiry queue: its account, time, and id. */
interface QueuedFail {
  account: string;
  ts: number;
  id: number;
}

/** Compact the queue once its consumed head grows past this, to bound memory. */
const COMPACT_THRESHOLD = 1024;

/**
 * The incremental tally. A single expiry queue holds every in-window fail in time
 * order; per-account counts track how many each account has. Each fail enqueues,
 * bumps its count, then drains the queue front of everything now past the window,
 * decrementing counts as it goes. That is amortized O(1) and assumes in-order
 * time. Fires on the rising edge, exactly where the naive scan does.
 */
export function makeIncrementalTally(): Detector {
  let queue: QueuedFail[] = [];
  let head = 0;
  // Per-account state (counts, firing) is not pruned when an account's count reaches
  // zero. The scenario draws from a bounded account pool (CORPUS_ACCOUNTS), so these
  // stay small; an unbounded-account runtime is a later-slice concern (#4).
  const counts = new Map<string, number>();
  const firing = new Set<string>();
  return {
    step(event: MatchView): Alert | null {
      if (event.outcome !== "fail") {
        return null;
      }
      queue.push({ account: event.account, ts: event.ts, id: event.id });
      counts.set(event.account, (counts.get(event.account) ?? 0) + 1);
      const cutoff = event.ts - SCAN_WINDOW_S;
      while (head < queue.length) {
        const front = queue[head];
        if (front === undefined || front.ts > cutoff) {
          break;
        }
        counts.set(front.account, (counts.get(front.account) ?? 1) - 1);
        head++;
      }
      if (head >= COMPACT_THRESHOLD && head * 2 >= queue.length) {
        queue = queue.slice(head);
        head = 0;
      }
      const count = counts.get(event.account) ?? 0;
      if (count < THRESHOLD) {
        firing.delete(event.account);
        return null;
      }
      if (firing.has(event.account)) {
        return null;
      }
      firing.add(event.account);
      return { reason: REASON, at: event.ts, events: [event.id] };
    },
    retained(): number {
      return queue.length - head;
    },
  };
}
