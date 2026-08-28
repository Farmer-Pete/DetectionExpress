/**
 * The Correctness scorer: an attack-level, threat-keyed match of Alerts against
 * Ground truth. It is mechanism only; it knows nothing about the kiosk or any
 * scenario semantics. The Match node is its single writer, feeding it Events in
 * order, so scoring is one ordered fold with no race. The sampler only reads
 * `reading()`; it never changes scoring state.
 *
 * A global `Counts` feeds the score of record. A rolling ring of the last N
 * outcomes feeds the gauge, so a Rule edit shows within a window. Both run
 * through `score`. An empty ring reads 100.
 */
import type { Alert } from "./alert";
import type { Attack } from "./attack";
import type { PipeEvent } from "./event";

/** The global tallies behind the score of record. */
export interface Counts {
  caught: number;
  missed: number;
  falseAlerts: number;
}

/**
 * score = 100 * caught / (caught + wFn*missed + wFp*falseAlerts). A missed Attack
 * weighs more than a false Alert. Reads 100 when the denominator is zero.
 */
export function score(counts: Counts, wFn: number, wFp: number): number {
  const denom = counts.caught + wFn * counts.missed + wFp * counts.falseAlerts;
  if (denom === 0) {
    return 100;
  }
  return (100 * counts.caught) / denom;
}

/** The scorer's tuning: injected so `sim/` stays free of `game/` constants. */
export interface ScorerConfig {
  /** Distinct cited ids an Alert must share with an Attack to credit it. */
  threshold: number;
  /** Outcomes kept in the rolling gauge ring. */
  window: number;
  /** False-negative (missed Attack) weight. */
  wFn: number;
  /** False-positive (false Alert) weight. */
  wFp: number;
}

/** The reading the sampler publishes: the gauge value plus the global counts. */
export interface CorrectnessReading extends Counts {
  /** The rolling gauge over the last `window` outcomes. */
  rolling: number;
}

/** One resolved judgement, held in the rolling ring. */
type Outcome = "caught" | "missed" | "false";

export interface Scorer {
  /** Fold one Event's Alerts, in order. Closes expired Attacks first. */
  record(alerts: Alert | Alert[] | null | undefined, env: PipeEvent): void;
  /**
   * Close every pending Attack whose window ended before `gameTs` as a miss,
   * without a real Event. A checkpoint fires in a drain gap where no later Event
   * exists, so it settles misses on demand before Correctness is read.
   */
  advanceTo(gameTs: number): void;
  /** Close every remaining pending Attack as a miss at end of stream. */
  finalize(): void;
  /** The current gauge and global counts. Never mutates scoring state. */
  reading(): CorrectnessReading;
}

/** An Attack is pending until it resolves; both resolved states are terminal. */
type AttackState = "pending" | "caught" | "missed";

/** Normalize the Rule's return to a plain list; null, undefined, empty all drop. */
function alertList(alerts: Alert | Alert[] | null | undefined): Alert[] {
  if (alerts == null) {
    return [];
  }
  return Array.isArray(alerts) ? alerts : [alerts];
}

export function createScorer(attacks: readonly Attack[], config: ScorerConfig): Scorer {
  const state = new Map<number, AttackState>();
  // eventId -> the Attack that owns it, built once from Ground truth.
  const owner = new Map<number, number>();
  for (const attack of attacks) {
    state.set(attack.id, "pending");
    for (const eventId of attack.eventIds) {
      owner.set(eventId, attack.id);
    }
  }

  const counts: Counts = { caught: 0, missed: 0, falseAlerts: 0 };
  const ring: Outcome[] = [];

  function push(outcome: Outcome): void {
    ring.push(outcome);
    if (ring.length > config.window) {
      ring.shift();
    }
  }

  function resolve(attack: Attack, outcome: "caught" | "missed"): void {
    state.set(attack.id, outcome);
    if (outcome === "caught") {
      counts.caught += 1;
    } else {
      counts.missed += 1;
    }
    push(outcome);
  }

  /** Close every pending Attack whose window ended strictly before `ts`. */
  function closeExpired(ts: number): void {
    for (const attack of attacks) {
      if (state.get(attack.id) === "pending" && attack.window.endTs < ts) {
        resolve(attack, "missed");
      }
    }
  }

  /** Credit the first pending, reason-matching Attack the Alert proves. */
  function scoreAlert(alert: Alert): void {
    // Count distinct cited ids per owning Attack: the size of each intersection.
    const hits = new Map<number, number>();
    const seen = new Set<number>();
    for (const eventId of alert.events) {
      if (seen.has(eventId)) {
        continue;
      }
      seen.add(eventId);
      const attackId = owner.get(eventId);
      if (attackId !== undefined) {
        hits.set(attackId, (hits.get(attackId) ?? 0) + 1);
      }
    }
    for (const attack of attacks) {
      if (
        state.get(attack.id) === "pending" &&
        attack.reason === alert.reason &&
        (hits.get(attack.id) ?? 0) >= config.threshold
      ) {
        resolve(attack, "caught");
        return;
      }
    }
    counts.falseAlerts += 1;
    push("false");
  }

  return {
    record(alerts, env) {
      closeExpired(env.ts);
      for (const alert of alertList(alerts)) {
        scoreAlert(alert);
      }
    },
    advanceTo(gameTs) {
      closeExpired(gameTs);
    },
    finalize() {
      for (const attack of attacks) {
        if (state.get(attack.id) === "pending") {
          resolve(attack, "missed");
        }
      }
    },
    reading() {
      const rung: Counts = { caught: 0, missed: 0, falseAlerts: 0 };
      for (const outcome of ring) {
        if (outcome === "caught") {
          rung.caught += 1;
        } else if (outcome === "missed") {
          rung.missed += 1;
        } else {
          rung.falseAlerts += 1;
        }
      }
      return {
        rolling: score(rung, config.wFn, config.wFp),
        caught: counts.caught,
        missed: counts.missed,
        falseAlerts: counts.falseAlerts,
      };
    },
  };
}
