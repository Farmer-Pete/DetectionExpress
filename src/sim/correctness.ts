/**
 * The Correctness scorer: an attack-level, threat-keyed match of Findings against
 * Ground truth. It is mechanism only; it knows nothing about the kiosk or any
 * scenario semantics. The Detect node is its single writer, feeding it Findings in
 * order, so scoring is one ordered fold with no race. The sampler only reads
 * `reading()`; it never changes scoring state.
 *
 * A global `Counts` feeds the score of record. A rolling ring of the last N
 * outcomes feeds the gauge, so a Rule edit shows within a window. Both run
 * through `score`. An empty ring reads 100.
 *
 * The scorer also keeps a durable, append-only decision log (`decisions()`): one
 * resolved `Decision` per judgement, each carrying a deep-cloned, frozen snapshot,
 * so a later slice's UI history survives log aging.
 */

import type { Attack } from "./attack";
import type { PipeEvent } from "./event";
import type { AlertReason, Finding } from "./finding";

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
  /** Match a finding that carries an entity by entity+evidence first. Default false. */
  entityMatch?: boolean;
  /**
   * Game seconds a live finding lingers, unrefreshed, before it ages out of
   * `liveFindings()`. Optional, mirroring `entityMatch`; `createScorer` supplies
   * `DEFAULT_LIVE_HORIZON` when omitted.
   */
  liveHorizon?: number;
}

/** The reading the sampler publishes: the gauge value plus the global counts. */
export interface CorrectnessReading extends Counts {
  /** The rolling gauge over the last `window` outcomes. */
  rolling: number;
}

/**
 * A finding paired with its resolved entity, as the Detect task hands it to the
 * scorer. `entity` is the finding's subject value, resolved from `view[subjectType]`,
 * or undefined when the finding names no subject.
 */
export interface ScoredFinding {
  finding: Finding;
  entity?: string;
}

/** The three ways a judgement resolves. */
export type DecisionOutcome = "caught" | "missed" | "false";

/** Fields shared by every resolved Decision. */
interface DecisionBase {
  outcome: DecisionOutcome;
  /** Append order: 0, 1, 2, ... Strictly monotonic. The UI's stable sort key and id. */
  seq: number;
  /** Game seconds when it resolved. Display metadata; NOT an ordering key. */
  at: number;
}

/** An Attack caught by a crediting finding. */
export interface CaughtDecision extends DecisionBase {
  outcome: "caught";
  attackId: number;
  /** The attack's entity. */
  entity: string;
  /** Deep clone of the crediting finding, frozen. */
  finding: Finding;
}

/** A finding that credited no pending Attack. */
export interface FalseDecision extends DecisionBase {
  outcome: "false";
  /** The finding's resolved entity, if any. */
  entity?: string;
  /** Deep clone of the finding, frozen. */
  finding: Finding;
}

/** An Attack whose window closed with no crediting finding. */
export interface MissedDecision extends DecisionBase {
  outcome: "missed";
  attackId: number;
  entity: string;
  reason: AlertReason;
  /** A copy of the attack's window, not the live object. */
  window: { startTs: number; endTs: number };
}

/** One resolved judgement in the decision log. */
export type Decision = CaughtDecision | FalseDecision | MissedDecision;

/**
 * One currently-open finding for the findings panel. Frozen in place, not cloned:
 * the finding is already fresh and engine-owned by the time it reaches the scorer.
 * Identity for upsert/replace: every finding keys on `eventId` + `reason`, matching
 * the promote/replace contract in `finding.ts`. A re-emit on the same key replaces
 * the entry in place; a watch promotes to a hit without changing its seq.
 */
export interface LiveFinding {
  /** The emitted finding, frozen in place. */
  finding: Finding;
  /** The resolved subject, when the finding names one. */
  entity?: string;
  /** "watch" for a partial (isPartial), "hit" for a final. */
  state: "hit" | "watch";
  /** `alert.reason`: the hunt id. */
  reason: string;
  /** Cited evidence. */
  eventIds: number[];
  /** `env.ts` of the last emission. TRUSTED game seconds, never `alert.at`. */
  at: number;
  /** Stable insertion id for the UI. */
  seq: number;
}

export interface Scorer {
  /**
   * Fold one Event's Findings, in order, after a horizon sweep and closing expired
   * Attacks. A finding with `isPartial === true` is skipped by scoring (neither
   * caught nor false) but still upserts into the live set as a watch. "No finding"
   * is an empty array.
   *
   * Pinned order: (1) horizon-sweep the live set at `env.ts`, (2) close expired
   * Attacks (and drop any watch linked to a now-missed one), (3) upsert every
   * finding into the live set, (4) score every finding.
   *
   * Precondition: each `finding` must be plain, canonical data (no throwing getter,
   * `toJSON`, or `Proxy`). The one production caller, `runDetect`, guarantees this by
   * canonicalizing the player's return before calling here; unit tests pass plain
   * literals. The scorer's snapshot clone (a JSON round-trip) is safe only on such
   * data. This is a documented precondition, not a branded type.
   */
  record(findings: readonly ScoredFinding[], env: PipeEvent): void;
  /**
   * Close every pending Attack whose window ended before `gameTs` as a miss,
   * without a real Event. A checkpoint fires in a drain gap where no later Event
   * exists, so it settles misses on demand before Correctness is read. Also
   * horizon-sweeps the live set at `gameTs` first, and drops any watch linked to a
   * newly missed Attack.
   */
  advanceTo(gameTs: number): void;
  /** Close every remaining pending Attack as a miss at end of stream. Clears the live set. */
  finalize(): void;
  /** The current gauge and global counts. Never mutates scoring state. */
  reading(): CorrectnessReading;
  /**
   * The decision log in append (resolution) order. Returns a frozen fresh array
   * (`Object.freeze([...log])`) of already-frozen, deep-cloned decisions, so neither
   * the returned array nor any stored snapshot can be mutated by a consumer. Ordered
   * by `seq`; the UI reverses for newest-first.
   */
  decisions(): readonly Decision[];
  /**
   * The current live findings, seq-ordered. Returns a frozen fresh array
   * (`Object.freeze([...live.values()])`) of already-frozen entries: a shallow
   * copy, since each entry froze once at insert and is replaced, never mutated,
   * on promotion. Ranking is a UI concern; this is a stable insertion order only.
   */
  liveFindings(): readonly LiveFinding[];
}

/** One resolved judgement, held in the rolling ring. */
type Outcome = "caught" | "missed" | "false";

/** An Attack is pending until it resolves; both resolved states are terminal. */
type AttackState = "pending" | "caught" | "missed";

/** A structural deep clone via JSON. Safe only on plain, canonical data. */
function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Recursively freeze a value in place and return it. Only objects and arrays
 * descend; primitives are returned untouched. `instanceof Object` (not a runtime
 * `typeof`) tells object from primitive, so a plain finding snapshot freezes whole.
 */
function freezeDeep<T>(value: T): T {
  if (value instanceof Object) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      freezeDeep(child);
    }
  }
  return value;
}

/**
 * Game seconds a live finding lingers, unrefreshed, before `createScorer`'s
 * horizon sweep ages it out, absent a `ScorerConfig.liveHorizon` override.
 */
const DEFAULT_LIVE_HORIZON = 240;

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

  const liveHorizon = config.liveHorizon ?? DEFAULT_LIVE_HORIZON;

  const counts: Counts = { caught: 0, missed: 0, falseAlerts: 0 };
  const ring: Outcome[] = [];
  const log: Decision[] = [];
  // eventId::reason -> the open finding. Every finding carries an anchor now.
  const live = new Map<string, LiveFinding>();
  let nextLiveSeq = 0;

  function push(outcome: Outcome): void {
    ring.push(outcome);
    if (ring.length > config.window) {
      ring.shift();
    }
  }

  /** Append one frozen, deep-cloned decision. `seq` is its append index. */
  function append(decision: Decision): void {
    log.push(freezeDeep(decision));
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

  /** Emit a miss decision for an Attack, timestamped at its window close. */
  function missDecision(attack: Attack): MissedDecision {
    return {
      outcome: "missed",
      seq: log.length,
      at: attack.window.endTs,
      attackId: attack.id,
      entity: attack.entity,
      reason: attack.reason,
      window: { startTs: attack.window.startTs, endTs: attack.window.endTs },
    };
  }

  /** Close every pending Attack whose window ended strictly before `ts`. */
  function closeExpired(ts: number): void {
    for (const attack of attacks) {
      if (state.get(attack.id) === "pending" && attack.window.endTs < ts) {
        resolve(attack, "missed");
        append(missDecision(attack));
        dropWatchesForAttack(attack.id);
      }
    }
  }

  /**
   * Primary live-set eviction: drop any live entry whose last emission is now
   * `liveHorizon` seconds or more behind `ts`. Covers hits (caught or false) and
   * orphan watches uniformly; no code path here observes a "caught" transition, so
   * age is the only universal signal. A catch lingers `liveHorizon` seconds after
   * its last emission, then fades.
   */
  function sweepHorizon(ts: number): void {
    for (const [key, entry] of live) {
      if (ts - entry.at >= liveHorizon) {
        live.delete(key);
      }
    }
  }

  /**
   * Early-drop (watches only): when `attackId` resolves missed, drop any watch
   * anchored to an Event that Attack owns. An anchor-only link, weaker than
   * `hitsFor`'s full cited-id scan; the horizon sweep covers any watch this misses.
   */
  function dropWatchesForAttack(attackId: number): void {
    for (const [key, entry] of live) {
      if (entry.state === "watch" && owner.get(entry.finding.eventId) === attackId) {
        live.delete(key);
      }
    }
  }

  /**
   * Upsert one finding into the live set: partial -> watch, final -> hit, keyed by
   * `eventId::reason`. Every finding carries an anchor, so the key is always defined.
   * A promotion replaces the entry in place, keeping the original `seq` and refreshing
   * `state`/`eventIds`/`finding`/`at`.
   *
   * Freeze-only, no clone. The finding is already fresh and engine-owned: `runDetect`
   * canonicalizes it (`tasks.ts`, JSON round-trip) before `record`, and nothing
   * mutates it afterward. So this freezes that object in place rather than making a
   * second copy. The scorer never mutates a stored entry afterward.
   */
  function upsertLive(scored: ScoredFinding, ts: number): void {
    const finding = scored.finding;
    // Drop a partial "watch" whose owning attack has already resolved. `record`
    // closes expired attacks (dropping their linked watches) BEFORE this upsert, so a
    // partial that arrives after its attack window would otherwise seed a zombie watch:
    // `scoreFinding` skips partials, so it would never resolve and would linger until
    // the horizon. A partial for a still-pending or unowned attack is a normal watch.
    if (finding.isPartial === true) {
      const attackId = owner.get(finding.eventId);
      if (attackId !== undefined && state.get(attackId) !== "pending") {
        return;
      }
    }
    const liveState: "hit" | "watch" = finding.isPartial === true ? "watch" : "hit";
    const key = `${finding.eventId}::${finding.alert.reason}`;
    const existing = live.get(key);
    const seq = existing ? existing.seq : nextLiveSeq++;
    const entry: LiveFinding = {
      finding,
      state: liveState,
      reason: finding.alert.reason,
      eventIds: finding.alert.eventIds,
      at: ts,
      seq,
    };
    if (scored.entity !== undefined) {
      entry.entity = scored.entity;
    }
    live.set(key, freezeDeep(entry));
  }

  /**
   * Count distinct cited ids per owning Attack for one alert: the size of each
   * intersection between the alert's evidence and an Attack's owned ids.
   */
  function hitsFor(eventIds: readonly number[]): Map<number, number> {
    const hits = new Map<number, number>();
    const seen = new Set<number>();
    for (const eventId of eventIds) {
      if (seen.has(eventId)) {
        continue;
      }
      seen.add(eventId);
      const attackId = owner.get(eventId);
      if (attackId !== undefined) {
        hits.set(attackId, (hits.get(attackId) ?? 0) + 1);
      }
    }
    return hits;
  }

  /**
   * Credit the first pending Attack the finding proves. Precedence (3.3): when
   * `entityMatch` is on AND the finding carries an entity, match by entity; else by
   * reason. Evidence (>= threshold distinct cited ids owned by that Attack) is
   * required either way. "First pending" is the injected `attacks` array order, so
   * when two attacks tie the earlier element wins.
   */
  function scoreFinding(scored: ScoredFinding): void {
    const finding = scored.finding;
    if (finding.isPartial === true) {
      return;
    }
    const alert = finding.alert;
    const hits = hitsFor(alert.eventIds);
    const useEntity = config.entityMatch === true && scored.entity !== undefined;
    for (const attack of attacks) {
      if (state.get(attack.id) !== "pending") {
        continue;
      }
      const predicate = useEntity
        ? attack.entity === scored.entity
        : attack.reason === alert.reason;
      if (predicate && (hits.get(attack.id) ?? 0) >= config.threshold) {
        resolve(attack, "caught");
        append({
          outcome: "caught",
          seq: log.length,
          at: alert.at,
          attackId: attack.id,
          entity: attack.entity,
          finding: deepClone(finding),
        });
        return;
      }
    }
    counts.falseAlerts += 1;
    push("false");
    const decision: FalseDecision = {
      outcome: "false",
      seq: log.length,
      at: alert.at,
      finding: deepClone(finding),
    };
    if (scored.entity !== undefined) {
      decision.entity = scored.entity;
    }
    append(decision);
  }

  return {
    record(findings, env) {
      // Pinned order: horizon sweep, close expired (+ its early watch-drop),
      // upsert every finding into the live set, then score every finding. Upsert
      // runs as its own pass, before scoring, so it never depends on which Attack
      // a finding ends up crediting.
      sweepHorizon(env.ts);
      closeExpired(env.ts);
      for (const scored of findings) {
        upsertLive(scored, env.ts);
      }
      for (const scored of findings) {
        scoreFinding(scored);
      }
    },
    advanceTo(gameTs) {
      sweepHorizon(gameTs);
      closeExpired(gameTs);
    },
    finalize() {
      for (const attack of attacks) {
        if (state.get(attack.id) === "pending") {
          resolve(attack, "missed");
          append(missDecision(attack));
        }
      }
      live.clear();
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
    decisions() {
      return Object.freeze([...log]);
    },
    liveFindings() {
      return Object.freeze([...live.values()]);
    },
  };
}
