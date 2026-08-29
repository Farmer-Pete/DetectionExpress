/**
 * The Optimization: the incremental tally the player applies to survive the peak
 * (GH3-PLAN.md sections 6.5 and 13). It is the same detector as the naive default
 * in `reference.ts` — same reason, threshold, window, and one Alert per burst — but
 * amortized O(1) instead of a re-scan, so the profiler prices it far faster and its
 * governed service rate clears the peak wave.
 *
 * A single expiry queue holds every in-window fail in time order; per-account counts
 * track how many each account has. Each fail enqueues, bumps its count, then drains
 * the queue front of everything now past the window, decrementing counts as it goes.
 * That assumes Events arrive in time order — the latent Slice-2 seed. The Slice-2
 * stream is in order, so the tally is correct; do not exploit the assumption here.
 *
 * `optimizationSource` is the module the editor loads and the browser run profiles;
 * it imports lodash by URL, the way a player would. `buildOptimizationAlgorithm` is
 * the in-process twin the deterministic tests run: the same logic with no import.
 */

import type { RawKioskV1 } from "../../endpoints/kiosk/formats/kiosk-v1";
import type { Alert } from "../../finding";
import { PIN_BRUTE_FORCE_REASON } from "./attacks";

/**
 * What the player applies over the naive default. Imports lodash by URL, like a
 * player. Keeps a global expiry queue plus per-account counts, and remembers each
 * account's most recent fail ids so a firing Alert can still cite real evidence.
 */
export const optimizationSource = `import _ from "https://esm.sh/lodash@4.17.21";
export function normalize(raw) {
  return {
    account: raw.acct,
    terminal: raw.term,
    outcome: raw.res === "WRONG_PIN" ? "fail" : "success",
  };
}
const WINDOW = 300; // 5 minutes in game seconds
const THRESHOLD = 5;
const queue = []; // every in-window fail, in time order
let head = 0;
const counts = {}; // per-account in-window fail count
const recent = {}; // per-account last THRESHOLD fail ids, the evidence to cite
const firing = {};
export function match(e) {
  if (e.outcome !== "fail") return null;
  queue.push({ account: e.account, ts: e.ts, id: e.id });
  counts[e.account] = (counts[e.account] ?? 0) + 1;
  const r = (recent[e.account] ??= []);
  r.push(e.id);
  if (r.length > THRESHOLD) r.shift();
  const cutoff = e.ts - WINDOW;
  while (head < queue.length && queue[head].ts <= cutoff) {
    counts[queue[head].account] -= 1;
    head++;
  }
  if (head >= 1024 && head * 2 >= queue.length) {
    queue.splice(0, head);
    head = 0;
  }
  if ((counts[e.account] ?? 0) < THRESHOLD) {
    firing[e.account] = false;
    return null;
  }
  if (firing[e.account]) return null; // one Alert per burst; no duplicates
  firing[e.account] = true;
  return { reason: "pin_brute_force", at: e.ts, eventIds: recent[e.account].slice() };
}
`;

/** The player's shape after Normalize. */
interface NormalizedKiosk {
  account: string;
  terminal: string;
  outcome: "success" | "fail";
}

/** The flat view Match hands the Rule: the normalized payload plus engine fields. */
interface MatchView extends NormalizedKiosk {
  id: number;
  ts: number;
  endpoint: string;
}

export interface OptimizationAlgorithm {
  normalize(raw: RawKioskV1): NormalizedKiosk;
  match(e: MatchView): Alert | null;
}

/** One queued fail in the global expiry queue: its account, time, and id. */
interface QueuedFail {
  account: string;
  ts: number;
  id: number;
}

/** Compact the queue once its consumed head grows past this, to bound memory. */
const COMPACT_THRESHOLD = 1024;

const WINDOW = 300; // 5 minutes in game seconds
const THRESHOLD = 5;

/**
 * The in-process twin. State lives per instance, so a fresh instance replays the
 * same run cleanly, the way reloading the source module would. Amortized O(1) per
 * Event, with state bounded to one window plus a per-account ring of THRESHOLD ids.
 */
export function buildOptimizationAlgorithm(): OptimizationAlgorithm {
  let queue: QueuedFail[] = [];
  let head = 0;
  // Per-account state (counts, recent, firing) is not pruned when an account's
  // count reaches zero. The scenario draws from a bounded account pool
  // (CORPUS_ACCOUNTS), so these Maps stay small. An unbounded-account runtime, where
  // a stream of ever-new accounts would grow them for the whole run, is a later-slice
  // concern (#4).
  const counts = new Map<string, number>();
  const recent = new Map<string, number[]>();
  const firing = new Set<string>();

  return {
    normalize(raw) {
      return {
        account: raw.acct,
        terminal: raw.term,
        outcome: raw.res === "WRONG_PIN" ? "fail" : "success",
      };
    },
    match(e) {
      if (e.outcome !== "fail") {
        return null;
      }
      queue.push({ account: e.account, ts: e.ts, id: e.id });
      counts.set(e.account, (counts.get(e.account) ?? 0) + 1);
      const ids = recent.get(e.account) ?? [];
      ids.push(e.id);
      if (ids.length > THRESHOLD) {
        ids.shift();
      }
      recent.set(e.account, ids);

      // Eviction assumes Events arrive in time order: it drains the queue front
      // only forward, so a later Event that arrived early would slip past its
      // window and drop from the tally. That in-order assumption is the seed a
      // later slice (#5) reveals; the Slice-2 stream is in order, so it stays
      // hidden and the tally stays correct (see GH3-PLAN.md 6.5).
      const cutoff = e.ts - WINDOW;
      while (head < queue.length) {
        const front = queue[head];
        if (front === undefined || front.ts > cutoff) {
          break;
        }
        counts.set(front.account, (counts.get(front.account) ?? 0) - 1);
        head++;
      }
      if (head >= COMPACT_THRESHOLD && head * 2 >= queue.length) {
        queue = queue.slice(head);
        head = 0;
      }

      if ((counts.get(e.account) ?? 0) < THRESHOLD) {
        firing.delete(e.account);
        return null;
      }
      if (firing.has(e.account)) {
        return null; // one Alert per burst; no duplicates
      }
      firing.add(e.account);
      return { reason: PIN_BRUTE_FORCE_REASON, at: e.ts, eventIds: [...ids] };
    },
  };
}
