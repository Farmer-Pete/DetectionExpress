/**
 * The actor engine: the shared state-machine types and the deterministic scheduler
 * from ADR-0007. An actor is a small typed FSM that reads the environment and its
 * own state and emits readings on a transition. `runActors` owns game time, seeds
 * each actor from the run seed and its id, and activates them in a fixed,
 * seed-derived order. It reads no wall clock (ARCHITECTURE rule 8).
 */
import { randomLcg } from "d3-random";
import { GAME_SECONDS_PER_TICK } from "../../game/tuning";

/** The seeded input an actor reads to choose its first tick. */
interface StartContext {
  rng: () => number;
}

/** The seeded input and current tick an actor reads on a transition. */
interface ActContext<Env> {
  env: Env;
  rng: () => number;
  tick: number;
}

/** A transition's result: the readings it emitted, and its next tick or dormancy. */
interface ActResult<Reading> {
  readings: Reading[];
  nextTick: number | "dormant";
}

/**
 * A deterministic state machine the scheduler drives. It holds its own state; the
 * scheduler owns the rng, the priority, and the next tick, so the actor carries no
 * scheduling field.
 */
export interface Actor<Reading, Env> {
  readonly id: string;
  /** The actor's first tick, used to seed its scheduler record. */
  start(context: StartContext): number;
  /** One transition at `tick`: emit readings, then reschedule or go dormant. */
  act(context: ActContext<Env>): ActResult<Reading>;
}

/** Everything `runActors` needs, passed by name. */
interface RunActorsInput<Reading, Env> {
  actors: readonly Actor<Reading, Env>[];
  env: Env;
  runSeed: number;
  horizon: number;
}

/** The scheduler's per-actor record. Only the scheduler stores `nextTick`. */
interface ActorRecord<Reading, Env> {
  actor: Actor<Reading, Env>;
  rng: () => number;
  seededPriority: number;
  nextTick: number | "dormant";
}

/**
 * Convert a duration in minutes to whole game ticks, rounding up so a tap is never
 * scheduled before its ride could finish. Uses `GAME_SECONDS_PER_TICK` from tuning.
 */
export function minutesToTicks(minutes: number): number {
  return Math.ceil((minutes * 60) / GAME_SECONDS_PER_TICK);
}

/**
 * The fixed 32-bit string mixer (xmur3), folded to a single unsigned 32-bit value.
 * Unsigned on purpose: `randomLcg` folds its seed through `Math.abs(seed) | 0`, so a
 * signed value would collapse `n` and `-n` onto one stream.
 */
function xmur3(input: string): number {
  let h = 1779033703 ^ input.length;
  for (let index = 0; index < input.length; index++) {
    h = Math.imul(h ^ input.charCodeAt(index), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  h ^= h >>> 16;
  return h >>> 0;
}

/** The base per-actor seed: the unsigned 32-bit mix of `"${runSeed}:${actorId}"`. */
export function actorSeedHash(runSeed: number, actorId: string): number {
  return xmur3(`${runSeed}:${actorId}`);
}

/**
 * Assign each id a distinct seed in sorted-id order, so the outcome does not depend
 * on the input array order. On a taken seed it rehashes `"${runSeed}:${actorId}#${n}"`,
 * raising `n` until the seed is free, so two ids that collide onto one 32-bit value
 * still get distinct streams.
 */
function assignSeeds(runSeed: number, ids: string[]): Map<string, number> {
  const used = new Set<number>();
  const seeds = new Map<string, number>();
  for (const id of [...ids].sort()) {
    let seed = actorSeedHash(runSeed, id);
    let attempt = 1;
    while (used.has(seed)) {
      seed = xmur3(`${runSeed}:${id}#${attempt}`);
      attempt++;
    }
    used.add(seed);
    seeds.set(id, seed);
  }
  return seeds;
}

/**
 * Run the actors to the horizon and return every reading they emit, in emission
 * order. Deterministic: the same seed and actor set always yield the same readings,
 * under any permutation of the input array.
 *
 * It rejects a bad horizon and duplicate ids, seeds one rng per actor, draws each
 * `seededPriority` once, then repeatedly runs the due record with the earliest
 * `(nextTick, seededPriority, actorId)`. The horizon is half-open: a record at or
 * past it does not run. Every reschedule must strictly advance the tick or go
 * dormant, so the run always progresses.
 */
export function runActors<Reading, Env>(input: RunActorsInput<Reading, Env>): Reading[] {
  const { actors, env, runSeed, horizon } = input;
  if (!Number.isInteger(horizon) || horizon < 0) {
    throw new Error("runActors: horizon must be a finite, non-negative integer.");
  }
  const ids = actors.map((actor) => actor.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("runActors: two actors share an id.");
  }
  const seeds = assignSeeds(runSeed, ids);

  const records: ActorRecord<Reading, Env>[] = actors.map((actor) => {
    const seed = seeds.get(actor.id);
    if (seed === undefined) {
      throw new Error(`runActors: no seed for actor "${actor.id}".`);
    }
    const rng = randomLcg(seed);
    const seededPriority = rng();
    const nextTick = actor.start({ rng });
    return { actor, rng, seededPriority, nextTick };
  });

  const readings: Reading[] = [];
  for (;;) {
    let best: ActorRecord<Reading, Env> | null = null;
    let bestTick = 0;
    for (const record of records) {
      const tick = record.nextTick;
      if (tick === "dormant" || tick >= horizon) {
        continue;
      }
      const wins =
        best === null ||
        tick < bestTick ||
        (tick === bestTick &&
          (record.seededPriority < best.seededPriority ||
            (record.seededPriority === best.seededPriority && record.actor.id < best.actor.id)));
      if (wins) {
        best = record;
        bestTick = tick;
      }
    }
    if (best === null) {
      break;
    }
    const result = best.actor.act({ env, rng: best.rng, tick: bestTick });
    for (const reading of result.readings) {
      readings.push(reading);
    }
    const next = result.nextTick;
    if (next !== "dormant" && (!Number.isInteger(next) || next <= bestTick)) {
      throw new Error(
        `runActors: actor "${best.actor.id}" rescheduled to ${next}, which does not strictly advance ${bestTick}.`,
      );
    }
    best.nextTick = next;
  }
  return readings;
}
