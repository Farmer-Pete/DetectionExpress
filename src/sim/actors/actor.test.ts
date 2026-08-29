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
    const drawA = out.find((r) => r.id === A)?.draw;
    const drawB = out.find((r) => r.id === B)?.draw;
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
