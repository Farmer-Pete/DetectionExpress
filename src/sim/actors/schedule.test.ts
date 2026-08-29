import { describe, expect, it } from "vitest";
import type { Presence } from "../world/presence";
import { type Actor, type Admission, createSchedule, runActors } from "./actor";

/** A reading that records which actor fired, when, and its rng draw at that tick. */
interface Draw {
  id: string;
  tick: number;
  draw: number;
}

/** An actor that fires `count` times from `startTick`, every `interval` ticks. */
function pulse(id: string, startTick: number, interval: number, count: number): Actor<Draw, null> {
  let fired = 0;
  return {
    id,
    start: () => startTick,
    act: ({ tick, rng }) => {
      fired += 1;
      return {
        readings: [{ id, tick, draw: rng() }],
        nextTick: fired < count ? tick + interval : "dormant",
      };
    },
  };
}

/**
 * An actor whose start() draws rng and turns it into its first tick. The tick then
 * reveals whether seededPriority (the first draw) was taken before start (the
 * second), so this actor pins the locked priority-before-start order.
 */
function rngStart(id: string): Actor<Draw, null> {
  let fired = false;
  return {
    id,
    start: ({ rng }) => 1 + Math.floor(rng() * 997),
    act: ({ tick, rng }) => {
      if (fired) {
        return { readings: [], nextTick: "dormant" };
      }
      fired = true;
      return { readings: [{ id, tick, draw: rng() }], nextTick: "dormant" };
    },
  };
}

/** These two ids hash to the same base seed at runSeed 1 (from actor.test.ts). */
const COLLIDE_A = "a1649037";
const COLLIDE_B = "a1997380";

/**
 * The golden regression cast: three tied pulses whose within-tick order is
 * seed-decided, plus the pair of ids that collide at seed 1. Here at seed 4242 they
 * take ordinary distinct seeds; the seed-1 collision case below exercises the rehash.
 */
function goldenCast(): Actor<Draw, null>[] {
  return [
    pulse("r1", 0, 3, 3),
    pulse("r2", 0, 3, 3),
    pulse("r3", 0, 3, 3),
    pulse(COLLIDE_A, 1, 5, 2),
    pulse(COLLIDE_B, 1, 5, 2),
  ];
}

describe("schedule golden regression", () => {
  // Captured from the pre-refactor `runActors` (GH30). It pins the exact tie-break
  // order and every rng draw, so the extract-and-wrap refactor cannot silently shift
  // the batch bytes. The collision rehash is pinned by the seed-1 case further down.
  const golden: Draw[] = [
    { id: "r1", tick: 0, draw: 0.377997717121616 },
    { id: "r3", tick: 0, draw: 0.8511615127790719 },
    { id: "r2", tick: 0, draw: 0.14324259501881897 },
    { id: "a1997380", tick: 1, draw: 0.26770913670770824 },
    { id: "a1649037", tick: 1, draw: 0.6882882134523243 },
    { id: "r1", tick: 3, draw: 0.8861598307266831 },
    { id: "r3", tick: 3, draw: 0.8531265575438738 },
    { id: "r2", tick: 3, draw: 0.11654167249798775 },
    { id: "a1997380", tick: 6, draw: 0.7868463709019125 },
    { id: "r1", tick: 6, draw: 0.42830830509774387 },
    { id: "r3", tick: 6, draw: 0.71926368935965 },
    { id: "a1649037", tick: 6, draw: 0.17456470290198922 },
    { id: "r2", tick: 6, draw: 0.763482685899362 },
  ];

  it("reproduces GH30's exact readings for a fixed seed", () => {
    expect(runActors({ actors: goldenCast(), env: null, runSeed: 4242, horizon: 100 })).toEqual(
      golden,
    );
  });

  it("still matches under a permutation of the input actors", () => {
    const reversed = runActors({
      actors: goldenCast().reverse(),
      env: null,
      runSeed: 4242,
      horizon: 100,
    });
    expect(reversed).toEqual(golden);
  });

  // The pair collides only at runSeed 1 (equal base hashes), so this run actually
  // exercises the assignSeeds rehash that gives them distinct streams.
  const goldenCollision: Draw[] = [
    { id: "a1649037", tick: 1, draw: 0.7423868540208787 },
    { id: "a1997380", tick: 1, draw: 0.4407009135466069 },
    { id: "a1649037", tick: 6, draw: 0.7142570759169757 },
    { id: "a1997380", tick: 6, draw: 0.9241891386918724 },
  ];

  it("pins the collision rehash at the seed where the pair collides", () => {
    const out = runActors({
      actors: [pulse(COLLIDE_A, 1, 5, 2), pulse(COLLIDE_B, 1, 5, 2)],
      env: null,
      runSeed: 1,
      horizon: 100,
    });
    expect(out).toEqual(goldenCollision);
  });

  // Each rngStart actor's first tick reveals the priority-before-start draw order.
  const goldenStartOrder: Draw[] = [
    { id: "y", tick: 396, draw: 0.6575162573717535 },
    { id: "x", tick: 993, draw: 0.9943250650539994 },
  ];

  it("pins the priority-before-start draw order", () => {
    const out = runActors({
      actors: [rngStart("x"), rngStart("y")],
      env: null,
      runSeed: 4242,
      horizon: 2000,
    });
    expect(out).toEqual(goldenStartOrder);
  });
});

/** A single-shot actor due at `at`, then dormant. */
function once(id: string, at: number): Actor<Draw, null> {
  return {
    id,
    start: () => at,
    act: ({ tick, rng }) => ({ readings: [{ id, tick, draw: rng() }], nextTick: "dormant" }),
  };
}

describe("advanceTo half-open boundary", () => {
  const T = 10;

  it("runs an actor due at T-1, not at T or T+1 (batch path)", () => {
    expect(
      runActors({ actors: [once("a", T - 1)], env: null, runSeed: 1, horizon: T }),
    ).toHaveLength(1);
    expect(runActors({ actors: [once("a", T)], env: null, runSeed: 1, horizon: T })).toHaveLength(
      0,
    );
    expect(
      runActors({ actors: [once("a", T + 1)], env: null, runSeed: 1, horizon: T }),
    ).toHaveLength(0);
  });

  it("runs an actor due at T-1, not at T or T+1 (incremental path)", () => {
    const schedule = createSchedule({ actors: [once("a", T - 1)], env: null, runSeed: 1 });
    // Stepping one tick at a time to T runs the actor exactly at tick T-1.
    let total = 0;
    for (let tick = 0; tick < T; tick++) {
      total += schedule.advanceTo(tick + 1).readings.length;
    }
    expect(total).toBe(1);

    // A fresh actor due exactly at T does not run when we only advance to T.
    const atHorizon = createSchedule({ actors: [once("b", T)], env: null, runSeed: 1 });
    let ran = 0;
    for (let tick = 0; tick < T; tick++) {
      ran += atHorizon.advanceTo(tick + 1).readings.length;
    }
    expect(ran).toBe(0);
  });
});

describe("advanceTo frontier", () => {
  it("is a no-op when the horizon equals the frontier", () => {
    const schedule = createSchedule({ actors: [once("a", 5)], env: null, runSeed: 1 });
    schedule.advanceTo(3);
    const again = schedule.advanceTo(3);
    expect(again.readings).toHaveLength(0);
    expect(again.presences.size).toBe(0);
    expect(again.dormant).toHaveLength(0);
  });

  it("throws when the horizon is below the frontier", () => {
    const schedule = createSchedule({ actors: [once("a", 5)], env: null, runSeed: 1 });
    schedule.advanceTo(8);
    expect(() => schedule.advanceTo(7)).toThrow(/below the frontier/);
  });

  it("rejects a non-integer or negative horizon", () => {
    const schedule = createSchedule({ actors: [], env: null, runSeed: 1 });
    expect(() => schedule.advanceTo(1.5)).toThrow(/horizon/);
    expect(() => schedule.advanceTo(-1)).toThrow(/horizon/);
  });
});

describe("advanceTo step deltas", () => {
  /** A mover: it slides one edge, reporting a `moving` presence, then goes dormant. */
  function mover(id: string): Actor<Draw, null> {
    let done = false;
    return {
      id,
      start: () => 0,
      act: ({ tick, rng }) => {
        if (done) {
          return { readings: [], nextTick: "dormant" };
        }
        done = true;
        const presence: Presence = {
          kind: "moving",
          from: "cen",
          to: "mkt",
          line: "blue",
          fromTick: tick,
          untilTick: tick + 5,
        };
        return { readings: [{ id, tick, draw: rng() }], nextTick: tick + 5, presence };
      },
    };
  }

  it("carries a per-actor tick and only the actors that acted", () => {
    const schedule = createSchedule({
      actors: [mover("m1"), once("s1", 2)],
      env: null,
      runSeed: 9,
    });
    const first = schedule.advanceTo(1); // only m1 is due at tick 0
    expect(first.readings.map((r) => r.actorId)).toEqual(["m1"]);
    expect(first.readings[0]?.tick).toBe(0);
    expect(first.presences.get("m1")?.kind).toBe("moving");
    expect(first.presences.has("s1")).toBe(false); // s1 did not act, so no delta
  });
});

describe("admit", () => {
  function admissionFor(actor: Actor<Draw, null>): Admission<Draw, null> {
    return {
      actor,
      kind: "rider",
      initialPresence: (firstTick) => ({
        kind: "at",
        node: "cen",
        fromTick: firstTick,
        untilTick: firstTick,
      }),
    };
  }

  it("returns the admitted actor's first tick", () => {
    const schedule = createSchedule({ actors: [], env: null, runSeed: 7 });
    const firstTick = schedule.admit(admissionFor(once("C000001", 4)));
    expect(firstTick).toBe(4);
    expect(schedule.activeIds()).toContain("C000001");
  });

  it("seeds a transient deterministically for a seed", () => {
    const drawOf = (): number => {
      const schedule = createSchedule<Draw, null>({ actors: [], env: null, runSeed: 7 });
      schedule.admit(admissionFor(once("C000009", 0)));
      return schedule.advanceTo(1).readings[0]?.reading.draw ?? Number.NaN;
    };
    expect(drawOf()).toBe(drawOf());
  });

  it("rejects a first tick before the frontier", () => {
    const schedule = createSchedule({ actors: [once("a", 3)], env: null, runSeed: 1 });
    schedule.advanceTo(5); // frontier is now 5
    expect(() => schedule.admit(admissionFor(once("C000002", 4)))).toThrow(/before the frontier/);
  });

  it("rejects reusing a live id", () => {
    const schedule = createSchedule({ actors: [once("a", 3)], env: null, runSeed: 1 });
    expect(() => schedule.admit(admissionFor(once("a", 3)))).toThrow(/never reused/);
  });

  it("rejects reusing an id that was admitted and then evicted", () => {
    const schedule = createSchedule<Draw, null>({ actors: [], env: null, runSeed: 1 });
    schedule.admit(admissionFor(once("C000003", 0)));
    schedule.advanceTo(1); // the transient fires at tick 0 and evicts
    expect(schedule.activeIds()).toHaveLength(0);
    expect(() => schedule.admit(admissionFor(once("C000003", 1)))).toThrow(/never reused/);
  });
});

describe("initialTicks", () => {
  it("reports the first tick per non-dormant startup actor, omitting dormant starters", () => {
    const dormant: Actor<Draw, null> = {
      id: "sleeper",
      start: () => "dormant",
      act: () => ({ readings: [], nextTick: "dormant" }),
    };
    const schedule = createSchedule({
      actors: [once("a", 4), once("b", 7), dormant],
      env: null,
      runSeed: 1,
    });
    const ticks = schedule.initialTicks();
    expect(ticks.get("a")).toBe(4);
    expect(ticks.get("b")).toBe(7);
    expect(ticks.has("sleeper")).toBe(false);
    // A dormant starter is never live: it is not scanned and not in activeIds...
    expect([...schedule.activeIds()].sort()).toEqual(["a", "b"]);
    // ...but its id is still reserved for the whole run and cannot be reused.
    expect(() =>
      schedule.admit({
        actor: once("sleeper", 5),
        kind: "rider",
        initialPresence: (firstTick) => ({
          kind: "at",
          node: "cen",
          fromTick: firstTick,
          untilTick: firstTick,
        }),
      }),
    ).toThrow(/never reused/);
  });
});

describe("eviction and bounded cost", () => {
  it("drops a dormant actor and reports it in the step", () => {
    const schedule = createSchedule({ actors: [once("a", 0)], env: null, runSeed: 1 });
    const step = schedule.advanceTo(1);
    expect(step.dormant).toEqual(["a"]);
    expect(schedule.activeIds()).toHaveLength(0);
  });

  it("keeps the record count bounded over a long run of admissions and evictions", () => {
    const schedule = createSchedule({ actors: [], env: null, runSeed: 123 });
    let birth = 0;
    let maxLive = 0;
    // Each wave admits a short-lived transient that fires once and evicts; over
    // thousands of ticks the live set never grows, proving eviction bounds cost.
    for (let tick = 0; tick < 4000; tick++) {
      const id = `C${String(birth++).padStart(6, "0")}`;
      schedule.admit({
        actor: once(id, tick),
        kind: "rider",
        initialPresence: (firstTick) => ({
          kind: "at",
          node: "cen",
          fromTick: firstTick,
          untilTick: firstTick,
        }),
      });
      schedule.advanceTo(tick + 1); // the transient fires at `tick` and evicts
      maxLive = Math.max(maxLive, schedule.activeIds().length);
    }
    expect(maxLive).toBeLessThanOrEqual(1);
    expect(schedule.activeIds()).toHaveLength(0);
  });
});
