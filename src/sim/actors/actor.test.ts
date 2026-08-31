import { randomLcg } from "d3-random";
import { describe, expect, it } from "vitest";
import { type Actor, actorSeedHash, minutesToTicks, runActors } from "./actor";

/** A reading that records which actor fired and when. */
interface Tap {
  id: string;
  tick: number;
}

/** An actor that fires `count` times from `startTick`, every `interval` ticks. */
function pulse(id: string, startTick: number, interval: number, count: number): Actor<Tap, null> {
  let fired = 0;
  return {
    id,
    start: () => startTick,
    act: ({ tick }) => {
      fired += 1;
      return { readings: [{ id, tick }], nextTick: fired < count ? tick + interval : "dormant" };
    },
  };
}

/** Three actors on the same schedule, so their within-tick order is seed-decided. */
function tiedCast(): Actor<Tap, null>[] {
  return [pulse("r1", 0, 3, 3), pulse("r2", 0, 3, 3), pulse("r3", 0, 3, 3)];
}

describe("runActors timed readings", () => {
  it("tags each reading with the actor that emitted it and the tick it fired on", () => {
    // r1 fires at ticks 0, 3, 6; each tag's tick must match the emitting tick.
    const out = runActors({ actors: [pulse("r1", 0, 3, 3)], env: null, runSeed: 42, horizon: 100 });
    expect(out.map((t) => t.actorId)).toEqual(["r1", "r1", "r1"]);
    expect(out.map((t) => t.tick)).toEqual([0, 3, 6]);
    // The bare reading is still reachable under `.reading`.
    expect(out.map((t) => t.reading.id)).toEqual(["r1", "r1", "r1"]);
    expect(out.map((t) => t.reading.tick)).toEqual([0, 3, 6]);
  });
});

describe("runActors determinism", () => {
  it("is identical across two runs on one seed", () => {
    const first = runActors({ actors: tiedCast(), env: null, runSeed: 42, horizon: 100 });
    const second = runActors({ actors: tiedCast(), env: null, runSeed: 42, horizon: 100 });
    expect(first).toEqual(second);
  });

  it("is invariant under a permutation of the input actors", () => {
    const forward = runActors({ actors: tiedCast(), env: null, runSeed: 42, horizon: 100 });
    const reversed = runActors({
      actors: tiedCast().reverse(),
      env: null,
      runSeed: 42,
      horizon: 100,
    });
    expect(reversed).toEqual(forward);
  });

  it("emits in non-decreasing tick order", () => {
    const out = runActors({ actors: tiedCast(), env: null, runSeed: 7, horizon: 100 });
    for (let i = 1; i < out.length; i++) {
      const here = out[i];
      const prior = out[i - 1];
      if (here !== undefined && prior !== undefined) {
        expect(here.tick).toBeGreaterThanOrEqual(prior.tick);
      }
    }
  });
});

describe("runActors guards", () => {
  it("rejects duplicate actor ids", () => {
    expect(() =>
      runActors({
        actors: [pulse("x", 0, 1, 1), pulse("x", 0, 1, 1)],
        env: null,
        runSeed: 1,
        horizon: 10,
      }),
    ).toThrow(/share an id/);
  });

  it("rejects a reschedule that does not strictly advance the tick", () => {
    const stuck: Actor<Tap, null> = {
      id: "stuck",
      start: () => 0,
      act: ({ tick }) => ({ readings: [], nextTick: tick }),
    };
    expect(() => runActors({ actors: [stuck], env: null, runSeed: 1, horizon: 10 })).toThrow(
      /strictly advance/,
    );
  });

  it("rejects a fractional reschedule", () => {
    const fractional: Actor<Tap, null> = {
      id: "frac",
      start: () => 0,
      act: ({ tick }) => ({ readings: [], nextTick: tick + 0.5 }),
    };
    expect(() => runActors({ actors: [fractional], env: null, runSeed: 1, horizon: 10 })).toThrow(
      /strictly advance/,
    );
  });

  it("rejects a non-integer or negative horizon", () => {
    expect(() => runActors({ actors: [], env: null, runSeed: 1, horizon: 1.5 })).toThrow(/horizon/);
    expect(() => runActors({ actors: [], env: null, runSeed: 1, horizon: -1 })).toThrow(/horizon/);
  });

  it("rejects a start tick that is not a non-negative integer", () => {
    const startingAt = (at: number): Actor<Tap, null> => ({
      id: "s",
      start: () => at,
      act: ({ tick }) => ({ readings: [{ id: "s", tick }], nextTick: "dormant" }),
    });
    for (const bad of [Number.NaN, 0.5, -1]) {
      expect(() =>
        runActors({ actors: [startingAt(bad)], env: null, runSeed: 1, horizon: 10 }),
      ).toThrow(/started at/);
    }
  });

  it("accepts a valid integer start", () => {
    const valid: Actor<Tap, null> = {
      id: "v",
      start: () => 3,
      act: ({ tick }) => ({ readings: [{ id: "v", tick }], nextTick: "dormant" }),
    };
    expect(runActors({ actors: [valid], env: null, runSeed: 1, horizon: 10 })).toHaveLength(1);
  });
});

describe("runActors tie-break order", () => {
  it("orders due records by (nextTick, seededPriority, actorId)", () => {
    const runSeed = 42;
    const ids = ["r1", "r2", "r3"];
    // Independent oracle: each actor's seededPriority is the first draw of its own
    // stream, and its stream is seeded by the (runSeed, id) hash. These ids do not
    // collide on their base seed, so no rehash is involved.
    const priority = new Map(ids.map((id) => [id, randomLcg(actorSeedHash(runSeed, id))()]));
    const expected = [...ids].sort((a, b) => {
      const pa = priority.get(a) ?? 0;
      const pb = priority.get(b) ?? 0;
      if (pa !== pb) {
        return pa - pb;
      }
      return a < b ? -1 : 1;
    });
    // horizon 3 so only the tie at tick 0 fires: each pulse reschedules to tick 3,
    // which is at the half-open horizon and does not run.
    const out = runActors({ actors: tiedCast(), env: null, runSeed, horizon: 3 });
    expect(out.map((tap) => tap.tick)).toEqual([0, 0, 0]);
    expect(out.map((tap) => tap.actorId)).toEqual(expected);
  });
});

describe("runActors half-open horizon", () => {
  function once(id: string, at: number): Actor<Tap, null> {
    return {
      id,
      start: () => at,
      act: ({ tick }) => ({ readings: [{ id, tick }], nextTick: "dormant" }),
    };
  }
  const horizon = 10;

  it("runs an actor due at horizon - 1", () => {
    expect(
      runActors({ actors: [once("a", horizon - 1)], env: null, runSeed: 1, horizon }),
    ).toHaveLength(1);
  });

  it("does not run an actor due at horizon", () => {
    expect(
      runActors({ actors: [once("a", horizon)], env: null, runSeed: 1, horizon }),
    ).toHaveLength(0);
  });

  it("does not run an actor due at horizon + 1", () => {
    expect(
      runActors({ actors: [once("a", horizon + 1)], env: null, runSeed: 1, horizon }),
    ).toHaveLength(0);
  });
});

describe("actorSeedHash", () => {
  it("canonicalizes to an unsigned 32-bit integer", () => {
    for (const id of ["r1", "alpha", "", "a1649037", "verylongactoridentifier"]) {
      const seed = actorSeedHash(7, id);
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThan(2 ** 32);
    }
  });

  it("gives distinct ids distinct base seeds in the common case", () => {
    const ids = ["r1", "r2", "r3", "r4", "r5"];
    const seeds = new Set(ids.map((id) => actorSeedHash(3, id)));
    expect(seeds.size).toBe(ids.length);
  });
});

describe("runActors forced seed collision", () => {
  interface Draw {
    id: string;
    draw: number;
  }
  // These two ids hash to the same base seed at runSeed 1 (found offline).
  const RUN = 1;
  const A = "a1649037";
  const B = "a1997380";

  function sampler(id: string): Actor<Draw, null> {
    return {
      id,
      start: () => 0,
      act: ({ rng }) => ({ readings: [{ id, draw: rng() }], nextTick: "dormant" }),
    };
  }

  it("confirms the two ids collide on their base seed", () => {
    expect(actorSeedHash(RUN, A)).toBe(actorSeedHash(RUN, B));
  });

  it("still gives the colliding ids distinct streams", () => {
    const out = runActors({
      actors: [sampler(A), sampler(B)],
      env: null,
      runSeed: RUN,
      horizon: 5,
    });
    const drawA = out.find((r) => r.reading.id === A)?.reading.draw;
    const drawB = out.find((r) => r.reading.id === B)?.reading.draw;
    expect(drawA).toBeDefined();
    expect(drawB).toBeDefined();
    expect(drawA).not.toBe(drawB);
  });

  it("resolves the collision the same under any input permutation", () => {
    const forward = runActors({
      actors: [sampler(A), sampler(B)],
      env: null,
      runSeed: RUN,
      horizon: 5,
    });
    const reversed = runActors({
      actors: [sampler(B), sampler(A)],
      env: null,
      runSeed: RUN,
      horizon: 5,
    });
    expect(reversed).toEqual(forward);
  });
});

/**
 * A frozen copy of the pre-heap linear scan, kept only as an independent oracle
 * for the parity test below. It must never be "improved": drift here would blunt
 * the parity check it exists to run. Do not import from `actor.ts` — it deliberately
 * duplicates the scheduling loop, not the guards, since the guards run once, up
 * front, in both implementations the same way.
 */
function referenceRunActors<Reading, Env>(input: {
  actors: readonly Actor<Reading, Env>[];
  env: Env;
  runSeed: number;
  horizon: number;
}): Reading[] {
  const { actors, env, runSeed, horizon } = input;
  interface Record_ {
    actor: Actor<Reading, Env>;
    rng: () => number;
    seededPriority: number;
    nextTick: number | "dormant";
  }
  const records: Record_[] = actors.map((actor) => {
    const seed = actorSeedHash(runSeed, actor.id);
    const rng = randomLcg(seed);
    const seededPriority = rng();
    const nextTick = actor.start({ rng });
    return { actor, rng, seededPriority, nextTick };
  });

  const readings: Reading[] = [];
  for (;;) {
    let best: Record_ | null = null;
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
    best.nextTick = result.nextTick;
  }
  return readings;
}

/** A reading a cast member emits: which member fired, at what tick, and its draw. */
interface CastReading {
  id: string;
  tick: number;
  draw: number;
}

/**
 * Build a random cast whose base seeds never collide, so the parity test exercises
 * only the ordinary (non-rehashed) path. Each member starts at a random tick, or
 * goes dormant immediately, and on every `act` it rerolls whether it goes dormant
 * next or reschedules a random strictly-later tick, so the cast includes the
 * dormant transition the plan calls out.
 */
function randomCast(
  runSeed: number,
  size: number,
  seedRng: () => number,
): Actor<CastReading, null>[] {
  const used = new Set<number>();
  const actors: Actor<CastReading, null>[] = [];
  let n = 0;
  while (actors.length < size) {
    const id = `actor-${n}`;
    n += 1;
    const seed = actorSeedHash(runSeed, id);
    if (used.has(seed)) {
      continue; // skip a colliding id: the parity cast avoids the rehash path
    }
    used.add(seed);

    const startsDormant = seedRng() < 0.1;
    const startTick = startsDormant ? 0 : Math.floor(seedRng() * 20);
    actors.push({
      id,
      start: () => (startsDormant ? "dormant" : startTick),
      act: ({ rng, tick }) => {
        const draw = rng();
        const goesDormant = rng() < 0.15;
        return {
          readings: [{ id, tick, draw }],
          nextTick: goesDormant ? "dormant" : tick + 1 + Math.floor(rng() * 5),
        };
      },
    });
  }
  return actors;
}

describe("runActors heap parity", () => {
  it("matches the linear-scan oracle on random casts and seeds, dormant picks included", () => {
    const seedRng = randomLcg(20260830);
    for (let trial = 0; trial < 40; trial++) {
      const runSeed = Math.floor(seedRng() * 1_000_000);
      const size = 1 + Math.floor(seedRng() * 12);
      const horizon = 5 + Math.floor(seedRng() * 60);
      const cast = randomCast(runSeed, size, seedRng);

      const expected = referenceRunActors({ actors: cast, env: null, runSeed, horizon });
      const actual = runActors({ actors: cast, env: null, runSeed, horizon });
      expect(actual.map((timed) => timed.reading)).toEqual(expected);
    }
  });
});

describe("minutesToTicks", () => {
  it("matches a hand-checked table (2 game seconds per tick)", () => {
    expect(minutesToTicks(1)).toBe(30);
    expect(minutesToTicks(2)).toBe(60);
    expect(minutesToTicks(3)).toBe(90);
    expect(minutesToTicks(5)).toBe(150);
  });

  it("rounds a fractional minute up to a whole tick", () => {
    expect(minutesToTicks(0.5)).toBe(15);
    expect(minutesToTicks(1.01)).toBe(31);
  });
});
