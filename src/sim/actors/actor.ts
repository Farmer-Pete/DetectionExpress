/**
 * The actor engine: the shared state-machine types and the deterministic scheduler
 * from ADR-0007. An actor is a small typed FSM that reads the environment and its
 * own state and emits readings on a transition.
 *
 * `createSchedule` owns game time. It seeds each startup actor from the run seed and
 * its id, activates them in a fixed, seed-derived order, and then STEPS forward: a
 * half-open `advanceTo(horizon)` runs every actor due below the horizon, `admit`
 * lets a transient enter at runtime, and a dormant actor is evicted so a perpetual
 * run stays bounded. `runActors` is a thin wrapper that runs one schedule straight
 * to a horizon, for the batch path and its byte-identical readings. Neither reads a
 * wall clock (ARCHITECTURE rule 8).
 */
import { randomLcg } from "d3-random";
import { GAME_SECONDS_PER_TICK } from "../../game/tuning";
import type { Presence } from "../world/presence";
import type { ActorView } from "../world-snapshot";

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
  /**
   * The actor's position after this transition. Additive and live-only: the batch
   * path (`runActors`) reads only `readings` and `nextTick`, so it ignores this.
   */
  presence?: Presence;
}

/**
 * A deterministic state machine the scheduler drives. It holds its own state; the
 * scheduler owns the rng, the priority, and the next tick, so the actor carries no
 * scheduling field.
 */
export interface Actor<Reading, Env> {
  readonly id: string;
  /** The actor's first tick, a non-negative integer, or `"dormant"` to never run. */
  start(context: StartContext): number | "dormant";
  /** One transition at `tick`: emit readings, then reschedule or go dormant. */
  act(context: ActContext<Env>): ActResult<Reading>;
}

/** One reading, tagged with the actor that emitted it and the tick it fired on. */
interface TimedReading<Reading> {
  reading: Reading;
  actorId: string;
  /** The tick this reading was emitted on. */
  tick: number;
}

/**
 * A single step's output. `readings` is in scheduled order, each carrying its own
 * tick (a live step spans one tick, so they share it; a batch step may span many).
 * `presences` and `dormant` are DELTAS: only the actors that acted or went dormant
 * this step appear.
 */
export interface StepResult<Reading> {
  readings: TimedReading<Reading>[];
  presences: Map<string, Presence>;
  dormant: string[];
}

/**
 * A runtime admission for a transient actor. The spawner mints a fresh id, so
 * `start()` returns a tick at or after the frontier. The engine records `kind` at
 * admission and calls `initialPresence(firstTick)` once `admit` computes the tick.
 */
export interface Admission<Reading, Env> {
  actor: Actor<Reading, Env>;
  kind: ActorView["kind"];
  initialPresence(firstTick: number): Presence;
}

/** The steppable schedule: half-open forward stepping, runtime admission, eviction. */
export interface Schedule<Reading, Env> {
  /** Run every actor due below `horizon`, forward only. Returns the step's delta. */
  advanceTo(horizon: number): StepResult<Reading>;
  /** Admit a transient. Returns its first tick, which must be at or after the frontier. */
  admit(admission: Admission<Reading, Env>): number;
  /** The first tick per non-dormant startup actor. Dormant starters are omitted. */
  initialTicks(): ReadonlyMap<string, number>;
  /** The live actor ids: startup non-evicted plus admitted, minus dormant. */
  activeIds(): readonly string[];
}

/** Everything `createSchedule` needs, passed by name. */
interface CreateScheduleInput<Reading, Env> {
  actors: readonly Actor<Reading, Env>[];
  env: Env;
  runSeed: number;
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
  seed: number;
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
 * Resolve a fresh seed for one id against the live seed set, using the same `id#n`
 * rehash as `assignSeeds`. A minted transient id never collides in practice, but a
 * 32-bit collision against a live seed still resolves deterministically.
 */
function resolveSeed(runSeed: number, id: string, live: ReadonlySet<number>): number {
  let seed = actorSeedHash(runSeed, id);
  let attempt = 1;
  while (live.has(seed)) {
    seed = xmur3(`${runSeed}:${id}#${attempt}`);
    attempt++;
  }
  return seed;
}

/**
 * Build one per-actor record in the locked construction order: one `randomLcg(seed)`,
 * then `seededPriority` as the first draw from that stream, then `actor.start`. Only
 * the seed source differs between startup seeding and runtime admission; this
 * per-actor order is identical for both, so an actor's rng stream is fixed by its
 * seed alone.
 */
function buildRecord<Reading, Env>(
  actor: Actor<Reading, Env>,
  seed: number,
): ActorRecord<Reading, Env> {
  const rng = randomLcg(seed);
  const seededPriority = rng();
  const nextTick = actor.start({ rng });
  return { actor, rng, seededPriority, nextTick, seed };
}

/** True when a next tick is a valid non-negative integer (or `"dormant"`). */
function isValidStart(nextTick: number | "dormant"): boolean {
  return nextTick === "dormant" || (Number.isInteger(nextTick) && nextTick >= 0);
}

/**
 * Build a steppable schedule over the startup actors. It rejects duplicate ids,
 * seeds one rng per actor over the complete sorted id set, draws each
 * `seededPriority` once, then calls `start()` to get the first tick. The frontier
 * `F` begins at 0; `advanceTo` moves it forward and never back.
 */
export function createSchedule<Reading, Env>(
  input: CreateScheduleInput<Reading, Env>,
): Schedule<Reading, Env> {
  const { actors, env, runSeed } = input;
  const ids = actors.map((actor) => actor.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("createSchedule: two actors share an id.");
  }
  const seeds = assignSeeds(runSeed, ids);

  const records = new Map<string, ActorRecord<Reading, Env>>();
  const liveSeeds = new Set<number>();
  const initialFirstTicks = new Map<string, number>();
  // Every id ever seen, startup or admitted, kept for the whole run. It outlives
  // eviction, so a retired id is never reused (the plan's whole-run id contract).
  const seenIds = new Set<string>(ids);
  for (const actor of actors) {
    const seed = seeds.get(actor.id);
    if (seed === undefined) {
      throw new Error(`createSchedule: no seed for actor "${actor.id}".`);
    }
    const record = buildRecord(actor, seed);
    if (!isValidStart(record.nextTick)) {
      throw new Error(
        `createSchedule: actor "${actor.id}" started at ${record.nextTick}, which is not "dormant" or a non-negative integer.`,
      );
    }
    // A startup actor that begins dormant never runs, so it is not retained as a
    // live record or seed and never appears in `activeIds()`. Its id stays in
    // `seenIds`, so it is still never reused.
    if (record.nextTick !== "dormant") {
      records.set(actor.id, record);
      liveSeeds.add(seed);
      initialFirstTicks.set(actor.id, record.nextTick);
    }
  }

  let frontier = 0;

  const advanceTo = (horizon: number): StepResult<Reading> => {
    if (!Number.isInteger(horizon) || horizon < 0) {
      throw new Error("advanceTo: horizon must be a finite, non-negative integer.");
    }
    if (horizon < frontier) {
      throw new Error(`advanceTo: horizon ${horizon} is below the frontier ${frontier}.`);
    }
    const readings: TimedReading<Reading>[] = [];
    const presences = new Map<string, Presence>();
    const dormant: string[] = [];

    for (;;) {
      let best: ActorRecord<Reading, Env> | null = null;
      let bestTick = 0;
      for (const record of records.values()) {
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
        readings.push({ reading, actorId: best.actor.id, tick: bestTick });
      }
      if (result.presence !== undefined) {
        presences.set(best.actor.id, result.presence);
      }
      const next = result.nextTick;
      if (next !== "dormant" && (!Number.isInteger(next) || next <= bestTick)) {
        throw new Error(
          `advanceTo: actor "${best.actor.id}" rescheduled to ${next}, which does not strictly advance ${bestTick}.`,
        );
      }
      if (next === "dormant") {
        records.delete(best.actor.id);
        liveSeeds.delete(best.seed);
        dormant.push(best.actor.id);
      } else {
        best.nextTick = next;
      }
    }

    frontier = horizon;
    return { readings, presences, dormant };
  };

  const admit = (admission: Admission<Reading, Env>): number => {
    const { actor } = admission;
    if (seenIds.has(actor.id)) {
      throw new Error(`admit: actor id "${actor.id}" was already used; ids are never reused.`);
    }
    const seed = resolveSeed(runSeed, actor.id, liveSeeds);
    const record = buildRecord(actor, seed);
    if (record.nextTick === "dormant") {
      throw new Error(
        `admit: transient "${actor.id}" started dormant; it must start at a real tick.`,
      );
    }
    if (!isValidStart(record.nextTick)) {
      throw new Error(
        `admit: transient "${actor.id}" started at ${record.nextTick}, which is not a non-negative integer.`,
      );
    }
    if (record.nextTick < frontier) {
      throw new Error(
        `admit: transient "${actor.id}" starts at ${record.nextTick}, before the frontier ${frontier}.`,
      );
    }
    records.set(actor.id, record);
    liveSeeds.add(seed);
    seenIds.add(actor.id);
    return record.nextTick;
  };

  return {
    advanceTo,
    admit,
    initialTicks: () => initialFirstTicks,
    activeIds: () => [...records.keys()],
  };
}

/**
 * Run the actors to the horizon and return every reading they emit, in emission
 * order. A thin wrapper over `createSchedule().advanceTo(horizon)`: it builds one
 * schedule and steps it straight to the horizon, so the batch readings stay
 * byte-identical to the pre-step scheduler. Deterministic under any permutation of
 * the input array.
 */
export function runActors<Reading, Env>(input: RunActorsInput<Reading, Env>): Reading[] {
  const { actors, env, runSeed, horizon } = input;
  // Reject a bad horizon up front, before seeding or any actor's start(), so the
  // batch path's observable behavior on invalid input matches the pre-step scheduler.
  if (!Number.isInteger(horizon) || horizon < 0) {
    throw new Error("runActors: horizon must be a finite, non-negative integer.");
  }
  const schedule = createSchedule({ actors, env, runSeed });
  const step = schedule.advanceTo(horizon);
  return step.readings.map((timed) => timed.reading);
}
