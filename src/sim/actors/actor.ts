/**
 * The actor engine: the shared state-machine types and the deterministic scheduler
 * from ADR-0007. An actor is a small typed FSM that reads the environment and its
 * own state and emits readings on a transition.
 *
 * `createSchedule` owns game time. It seeds each startup actor from the run seed and
 * its id, activates them in a fixed, seed-derived order, and then STEPS forward: a
 * half-open `advanceTo(horizon)` runs every actor due below the horizon, `admit`
 * lets a transient enter at runtime, and a dormant actor is evicted so a perpetual
 * run stays bounded. Due order is kept in an `ActorHeap`, a binary min-heap ordered
 * by the exact `(nextTick, seededPriority, actorId)` tie-break, so pops come out in
 * the same order the old linear scan produced. `runActors` is a thin wrapper that
 * runs one schedule straight to a horizon, for the batch path and its byte-identical
 * readings. Neither reads a wall clock (ARCHITECTURE rule 8).
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
export interface TimedReading<Reading> {
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

/**
 * Which seed domain an actor belongs to (GH117-PLAN.md "Scheduler seed isolation").
 * A `"scored-scenario"` actor is part of the scenario cast whose Events the scorer
 * reads; parity with the batch-composed run depends on its assigned seed and its
 * first-draw `seededPriority` never moving. `"ambient"` is everything else sharing
 * the schedule. `assignSeeds` below seeds every scored-scenario id first, as if no
 * ambient id existed, then seeds the ambient ids against what is already taken, so
 * adding ambient actors can never perturb a scenario actor's seed.
 */
export type ActorProvenance = "scored-scenario" | "ambient";

/**
 * An immutable recipe for one live actor: enough to build a fresh instance on
 * demand, without holding any of that instance's own mutable state. Actors are
 * mutable closures (a PIN attacker's `phase`, an account rider's `phase`), so a
 * blueprint that must build the same cast more than once — once for the batch
 * precompose, once for a live schedule — cannot hold built instances. It holds
 * this instead: a provenance tag, the presence to show before the actor's first
 * `act()` (mirroring `Admission.initialPresence`), and a pure `build()` that
 * returns a fresh instance sharing no state with any other call.
 */
export interface ActorDescriptor<Reading, Env> {
  readonly provenance: ActorProvenance;
  /**
   * The view kind the engine records for this actor's `ActorView`, mirroring
   * `Admission.kind` and `WorldFixture.kind`. The live engine reads it when it steps
   * the cast for the map (GH117-PLAN.md "Part B"); the batch precompose ignores it.
   */
  readonly kind: ActorView["kind"];
  readonly initialPresence: (firstTick: number) => Presence;
  build(): Actor<Reading, Env>;
}

/** Build one fresh actor per descriptor, in order. Two calls share no mutable state. */
export function instantiateActors<Reading, Env>(
  descriptors: readonly ActorDescriptor<Reading, Env>[],
): Actor<Reading, Env>[] {
  return descriptors.map((descriptor) => descriptor.build());
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
  /**
   * The ids to seed in the "ambient" domain (see `ActorProvenance`, `assignSeeds`).
   * Every id NOT in this set is "scored-scenario". Omitted, every id is
   * scored-scenario, reproducing today's single-domain seeding unchanged — every
   * existing caller that never passes this gets byte-identical seeds.
   */
  ambientIds?: ReadonlySet<string>;
}

/** Everything `runActors` needs, passed by name. */
interface RunActorsInput<Reading, Env> {
  actors: readonly Actor<Reading, Env>[];
  env: Env;
  runSeed: number;
  horizon: number;
  /** See `CreateScheduleInput.ambientIds`. */
  ambientIds?: ReadonlySet<string>;
}

/**
 * The scheduler's per-actor record: the actor, its rng stream, its tie-break
 * priority, and the seed that fixed both (kept so eviction can free the live seed).
 * The next tick lives on the heap entry, not here.
 */
interface ActorRecord<Reading, Env> {
  actor: Actor<Reading, Env>;
  rng: () => number;
  seededPriority: number;
  seed: number;
}

/**
 * One heap slot: a record due at a concrete tick. A dormant actor never gets an
 * entry, so `nextTick` here is always a number, never `"dormant"`.
 */
interface HeapEntry<Reading, Env> {
  record: ActorRecord<Reading, Env>;
  nextTick: number;
}

/**
 * A binary min-heap of due records, ordered by `(nextTick, seededPriority,
 * actorId)`: numeric tick first, then priority, then JavaScript string `<` on the
 * id. This is the same tie-break the old linear scan used, so the pop order, and
 * therefore the output, is identical.
 */
class ActorHeap<Reading, Env> {
  private readonly entries: HeapEntry<Reading, Env>[] = [];

  get size(): number {
    return this.entries.length;
  }

  /** The minimum entry, without removing it. */
  peek(): HeapEntry<Reading, Env> | undefined {
    return this.entries[0];
  }

  push(entry: HeapEntry<Reading, Env>): void {
    this.entries.push(entry);
    this.siftUp(this.entries.length - 1);
  }

  /** Remove and return the minimum entry. */
  pop(): HeapEntry<Reading, Env> | undefined {
    const top = this.entries[0];
    if (top === undefined) {
      return undefined;
    }
    const last = this.entries.pop();
    if (this.entries.length > 0 && last !== undefined) {
      this.entries[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  private less(a: HeapEntry<Reading, Env>, b: HeapEntry<Reading, Env>): boolean {
    if (a.nextTick !== b.nextTick) {
      return a.nextTick < b.nextTick;
    }
    if (a.record.seededPriority !== b.record.seededPriority) {
      return a.record.seededPriority < b.record.seededPriority;
    }
    return a.record.actor.id < b.record.actor.id;
  }

  private siftUp(index: number): void {
    let i = index;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const here = this.entries[i];
      const there = this.entries[parent];
      if (here === undefined || there === undefined || !this.less(here, there)) {
        break;
      }
      this.entries[i] = there;
      this.entries[parent] = here;
      i = parent;
    }
  }

  private siftDown(index: number): void {
    let i = index;
    const n = this.entries.length;
    for (;;) {
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      let smallest = i;
      const leftEntry = left < n ? this.entries[left] : undefined;
      const smallestEntry = this.entries[smallest];
      if (
        leftEntry !== undefined &&
        smallestEntry !== undefined &&
        this.less(leftEntry, smallestEntry)
      ) {
        smallest = left;
      }
      const rightEntry = right < n ? this.entries[right] : undefined;
      const currentSmallestEntry = this.entries[smallest];
      if (
        rightEntry !== undefined &&
        currentSmallestEntry !== undefined &&
        this.less(rightEntry, currentSmallestEntry)
      ) {
        smallest = right;
      }
      if (smallest === i) {
        break;
      }
      const a = this.entries[i];
      const b = this.entries[smallest];
      if (a === undefined || b === undefined) {
        break;
      }
      this.entries[i] = b;
      this.entries[smallest] = a;
      i = smallest;
    }
  }
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
 * Assign each id a distinct seed. Ids are split into two seed domains by
 * `ambientIds`: every id NOT in `ambientIds` (the "scored-scenario" domain) is
 * seeded first, in sorted order among itself, exactly as this function behaved
 * before ambient actors existed — so an id's outcome never depends on the input
 * array order, and never depends on whether any ambient id is even present. The
 * `ambientIds` are seeded second, in sorted order among themselves, against every
 * seed already taken. On a taken seed it rehashes `"${runSeed}:${id}#${n}"`, raising
 * `n` until the seed is free, exactly as before — the only change is domain order:
 * a collision can only ever bump an ambient id, never a scored-scenario one, because
 * a scored-scenario id's seed is always fully decided before any ambient id is even
 * considered. Passing no `ambientIds` (the default) puts every id in the
 * scored-scenario domain, reproducing the original single-domain behavior exactly.
 */
function assignSeeds(
  runSeed: number,
  ids: string[],
  ambientIds: ReadonlySet<string> = new Set(),
): Map<string, number> {
  const used = new Set<number>();
  const seeds = new Map<string, number>();
  const assign = (id: string): void => {
    let seed = actorSeedHash(runSeed, id);
    let attempt = 1;
    while (used.has(seed)) {
      seed = xmur3(`${runSeed}:${id}#${attempt}`);
      attempt++;
    }
    used.add(seed);
    seeds.set(id, seed);
  };
  for (const id of ids.filter((id) => !ambientIds.has(id)).sort()) {
    assign(id);
  }
  for (const id of ids.filter((id) => ambientIds.has(id)).sort()) {
    assign(id);
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

/** A freshly built record, paired with the first tick its `start()` returned. */
interface BuiltRecord<Reading, Env> {
  record: ActorRecord<Reading, Env>;
  nextTick: number | "dormant";
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
): BuiltRecord<Reading, Env> {
  const rng = randomLcg(seed);
  const seededPriority = rng();
  const nextTick = actor.start({ rng });
  return { record: { actor, rng, seededPriority, seed }, nextTick };
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
  const { actors, env, runSeed, ambientIds } = input;
  const ids = actors.map((actor) => actor.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("createSchedule: two actors share an id.");
  }
  const seeds = assignSeeds(runSeed, ids, ambientIds);

  // Due order lives in the heap; the records map tracks the live set for
  // `activeIds`/eviction; `liveSeeds` backs the collision rehash on admission.
  const heap = new ActorHeap<Reading, Env>();
  const records = new Map<string, ActorRecord<Reading, Env>>();
  const liveSeeds = new Set<number>();
  const initialFirstTicks = new Map<string, number>();
  // The startup id set. It is fixed at construction (startup actors are never
  // spawned at runtime), so it is bounded, unlike a per-admission log would be. It
  // reserves every startup id — including a dormant starter's — for the whole run,
  // so a startup id is never reused even after the actor is gone.
  const startupIds = new Set<string>(ids);

  for (const actor of actors) {
    const seed = seeds.get(actor.id);
    if (seed === undefined) {
      throw new Error(`createSchedule: no seed for actor "${actor.id}".`);
    }
    const { record, nextTick } = buildRecord(actor, seed);
    if (!isValidStart(nextTick)) {
      throw new Error(
        `createSchedule: actor "${actor.id}" started at ${nextTick}, which is not "dormant" or a non-negative integer.`,
      );
    }
    // A startup actor that begins dormant never runs, so it is not retained as a
    // live record or seed and never appears in `activeIds()`. Its id stays reserved
    // in `startupIds`, so it is still never reused.
    if (nextTick !== "dormant") {
      records.set(actor.id, record);
      liveSeeds.add(seed);
      initialFirstTicks.set(actor.id, nextTick);
      heap.push({ record, nextTick });
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

    // Pop the earliest due record while it sits strictly below the horizon. The heap
    // keeps the minimum at the top, so once the top is at or past the horizon every
    // remaining record is later still and the step is done.
    for (;;) {
      const top = heap.peek();
      if (top === undefined || top.nextTick >= horizon) {
        break;
      }
      const entry = heap.pop();
      if (entry === undefined) {
        break;
      }
      const { record, nextTick: bestTick } = entry;
      const result = record.actor.act({ env, rng: record.rng, tick: bestTick });
      for (const reading of result.readings) {
        readings.push({ reading, actorId: record.actor.id, tick: bestTick });
      }
      if (result.presence !== undefined) {
        presences.set(record.actor.id, result.presence);
      }
      const next = result.nextTick;
      if (next !== "dormant" && (!Number.isInteger(next) || next <= bestTick)) {
        throw new Error(
          `advanceTo: actor "${record.actor.id}" rescheduled to ${next}, which does not strictly advance ${bestTick}.`,
        );
      }
      if (next === "dormant") {
        records.delete(record.actor.id);
        liveSeeds.delete(record.seed);
        dormant.push(record.actor.id);
      } else {
        heap.push({ record, nextTick: next });
      }
    }

    frontier = horizon;
    return { readings, presences, dormant };
  };

  const admit = (admission: Admission<Reading, Env>): number => {
    const { actor } = admission;
    // Reject only a currently-reserved id: a live actor (in `records`) or a startup
    // id. An evicted transient's id is not retained, so nothing grows without bound;
    // spawners mint monotonic ids per prefix, so a live id is never regenerated.
    if (records.has(actor.id) || startupIds.has(actor.id)) {
      throw new Error(`admit: actor id "${actor.id}" was already used; ids are never reused.`);
    }
    const seed = resolveSeed(runSeed, actor.id, liveSeeds);
    const { record, nextTick } = buildRecord(actor, seed);
    if (nextTick === "dormant") {
      throw new Error(
        `admit: transient "${actor.id}" started dormant; it must start at a real tick.`,
      );
    }
    if (!isValidStart(nextTick)) {
      throw new Error(
        `admit: transient "${actor.id}" started at ${nextTick}, which is not a non-negative integer.`,
      );
    }
    if (nextTick < frontier) {
      throw new Error(
        `admit: transient "${actor.id}" starts at ${nextTick}, before the frontier ${frontier}.`,
      );
    }
    records.set(actor.id, record);
    liveSeeds.add(seed);
    heap.push({ record, nextTick });
    return nextTick;
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
 * order, each tagged with its actor id and the tick it fired on. A thin wrapper
 * over `createSchedule().advanceTo(horizon)`: it builds one schedule and steps it
 * straight to the horizon, so the batch readings stay byte-identical to the
 * pre-step scheduler (unwrap `.reading` for the bare stream). The actor tag lets
 * the composer attach ground truth from actor identity. Deterministic under any
 * permutation of the input array.
 */
export function runActors<Reading, Env>(
  input: RunActorsInput<Reading, Env>,
): TimedReading<Reading>[] {
  const { actors, env, runSeed, horizon, ambientIds } = input;
  // Reject a bad horizon up front, before seeding or any actor's start(), so the
  // batch path's observable behavior on invalid input matches the pre-step scheduler.
  if (!Number.isInteger(horizon) || horizon < 0) {
    throw new Error("runActors: horizon must be a finite, non-negative integer.");
  }
  const schedule = createSchedule({
    actors,
    env,
    runSeed,
    ...(ambientIds === undefined ? {} : { ambientIds }),
  });
  const step = schedule.advanceTo(horizon);
  return step.readings;
}
