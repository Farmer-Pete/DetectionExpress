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
  /** The actor's first tick, a non-negative integer, or `"dormant"` to never run. */
  start(context: StartContext): number | "dormant";
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

/** The scheduler's per-actor record: the actor, its rng stream, and its tie-break priority. */
interface ActorRecord<Reading, Env> {
  actor: Actor<Reading, Env>;
  rng: () => number;
  seededPriority: number;
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
 * `seededPriority` once, then repeatedly pops the due record with the earliest
 * `(nextTick, seededPriority, actorId)` off a min-heap. The horizon is half-open: a
 * record at or past it does not run, so the loop stops once the heap's minimum sits
 * at or past the horizon — every other record is later still. Every reschedule must
 * strictly advance the tick or go dormant, so the run always progresses. A dormant
 * actor never enters the heap, and a newly dormant actor is never pushed back.
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

  const heap = new ActorHeap<Reading, Env>();
  for (const actor of actors) {
    const seed = seeds.get(actor.id);
    if (seed === undefined) {
      throw new Error(`runActors: no seed for actor "${actor.id}".`);
    }
    const rng = randomLcg(seed);
    const seededPriority = rng();
    const nextTick = actor.start({ rng });
    if (nextTick !== "dormant" && (!Number.isInteger(nextTick) || nextTick < 0)) {
      throw new Error(
        `runActors: actor "${actor.id}" started at ${nextTick}, which is not "dormant" or a non-negative integer.`,
      );
    }
    if (nextTick !== "dormant") {
      heap.push({ record: { actor, rng, seededPriority }, nextTick });
    }
  }

  const readings: Reading[] = [];
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
      readings.push(reading);
    }
    const next = result.nextTick;
    if (next !== "dormant" && (!Number.isInteger(next) || next <= bestTick)) {
      throw new Error(
        `runActors: actor "${record.actor.id}" rescheduled to ${next}, which does not strictly advance ${bestTick}.`,
      );
    }
    if (next !== "dormant") {
      heap.push({ record, nextTick: next });
    }
  }
  return readings;
}
