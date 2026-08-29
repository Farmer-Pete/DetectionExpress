import { describe, expect, it } from "vitest";
import { GAME_SECONDS_PER_TICK } from "../../game/tuning";
import type { FareGateReading } from "../endpoints/fare-gate/gatekeep";
import { distanceMinutes, distanceTable } from "../world/distance";
import { world } from "../world/world";
import { minutesToTicks, runActors } from "./actor";
import { createRider } from "./rider";

const distances = distanceTable(world);
const env = { world, distances };

const HORIZON = 1000;

/**
 * The longest single-line ride in this world is red Harbor<->World's End at 12
 * minutes, and the base jitter adds up to 4 ticks. So no journey exceeds this many
 * ticks; the window closes this far below the horizon so every trip that starts can
 * still tap out before the run ends, leaving no dangling tap-in.
 */
const MAX_RIDE_TICKS = minutesToTicks(12) + 4;

/** A well-funded rider starting at the network's busiest interchange. */
const base = {
  card: "C09",
  origin: "cen",
  balance: 1000,
  window: { startTick: 0, endTick: HORIZON - MAX_RIDE_TICKS },
  fare: { base: 10, perMinute: 5 },
  jitterTicks: { min: 0, max: 4 },
  dwellTicks: { min: 2, max: 6 },
};

function ride(over: Partial<typeof base> = {}) {
  const rider = createRider({ ...base, ...over });
  return runActors({ actors: [rider], env, runSeed: 4242, horizon: HORIZON });
}

describe("createRider journeys", () => {
  const readings = ride();

  it("actually rides", () => {
    expect(readings.length).toBeGreaterThan(0);
  });

  it("alternates tap in and tap out, starting with an entry", () => {
    readings.forEach((reading, index) => {
      expect(reading.direction).toBe(index % 2 === 0 ? "in" : "out");
    });
  });

  it("prices each trip by distance, and the balance only ever falls", () => {
    let running = base.balance;
    for (let i = 0; i + 1 < readings.length; i += 2) {
      const entry = readings[i];
      const exit = readings[i + 1];
      if (entry === undefined || exit === undefined) {
        continue;
      }
      const fare =
        base.fare.base +
        base.fare.perMinute * distanceMinutes(distances, entry.station, exit.station);
      expect(running - entry.balance).toBe(fare);
      // Exit does not charge, so the balance is unchanged across the ride.
      expect(exit.balance).toBe(entry.balance);
      running = exit.balance;
    }
  });

  it("never lets a balance go negative", () => {
    for (const reading of readings) {
      expect(reading.balance).toBeGreaterThanOrEqual(0);
    }
  });

  it("rides at least the travel distance, on a line the origin and destination share", () => {
    for (let i = 0; i + 1 < readings.length; i += 2) {
      const entry = readings[i];
      const exit = readings[i + 1];
      if (entry === undefined || exit === undefined) {
        continue;
      }
      expect(entry.station).not.toBe(exit.station);
      expect(entry.line).toBe(exit.line);
      const origin = world.stations.find((s) => s.id === entry.station);
      const destination = world.stations.find((s) => s.id === exit.station);
      expect(origin?.lines).toContain(entry.line);
      expect(destination?.lines).toContain(entry.line);
      const durationTicks = (exit.ts - entry.ts) / GAME_SECONDS_PER_TICK;
      expect(durationTicks).toBeGreaterThanOrEqual(
        minutesToTicks(distanceMinutes(distances, entry.station, exit.station)),
      );
    }
  });

  it("is deterministic for a seed", () => {
    expect(ride()).toEqual(readings);
  });
});

describe("createRider dormancy", () => {
  it("goes dormant, emitting nothing, when it cannot afford any trip", () => {
    // Cheapest ride from Central is 2 minutes; fare = 10 + 5*2 = 20. A balance of
    // 19 cannot afford it, so the rider goes dormant with no taps.
    expect(ride({ balance: 19 })).toHaveLength(0);
  });
});

describe("createRider zero-dwell", () => {
  it("runs without throwing and always advances when the dwell can sample zero", () => {
    // A {min:0,max:0} dwell samples 0 every time. Without the one-tick floor, the
    // ARRIVE reschedule would equal the current tick and the scheduler would throw.
    const out = ride({ dwellTicks: { min: 0, max: 0 } });
    expect(out.length).toBeGreaterThan(0);
    const ticks = out.map((reading) => reading.ts);
    for (let i = 1; i < ticks.length; i++) {
      const here = ticks[i];
      const prior = ticks[i - 1];
      if (here !== undefined && prior !== undefined) {
        expect(here).toBeGreaterThanOrEqual(prior);
      }
    }
  });
});

describe("createRider validates its fare and balance", () => {
  it("rejects a negative perMinute, which would make the balance rise", () => {
    expect(() => createRider({ ...base, fare: { base: 10, perMinute: -5 } })).toThrow(/perMinute/);
  });

  it("rejects a fractional base, which would emit a fractional balance", () => {
    expect(() => createRider({ ...base, fare: { base: 2.5, perMinute: 5 } })).toThrow(/fare\.base/);
  });

  it("rejects a negative or fractional starting balance", () => {
    expect(() => createRider({ ...base, balance: -1 })).toThrow(/balance/);
    expect(() => createRider({ ...base, balance: 12.5 })).toThrow(/balance/);
  });

  it("prices a valid config by distance, and the balance only ever falls", () => {
    const readings = ride();
    let running = base.balance;
    for (let i = 0; i + 1 < readings.length; i += 2) {
      const entry = readings[i];
      const exit = readings[i + 1];
      if (entry === undefined || exit === undefined) {
        continue;
      }
      const fare =
        base.fare.base +
        base.fare.perMinute * distanceMinutes(distances, entry.station, exit.station);
      expect(Number.isInteger(entry.balance)).toBe(true);
      expect(running - entry.balance).toBe(fare);
      expect(entry.balance).toBeLessThanOrEqual(running);
      running = exit.balance;
    }
  });
});

/** Render one rider's day as a stable, human-readable line per tap. */
function renderDay(readings: readonly FareGateReading[]): string {
  return readings
    .map((reading) => {
      const tick = String(reading.ts / GAME_SECONDS_PER_TICK).padStart(4, " ");
      const direction = reading.direction === "in" ? "IN " : "OUT";
      return `t${tick}  ${direction}  ${reading.station.padEnd(3)}  ${reading.line.padEnd(6)}  bal ${reading.balance}`;
    })
    .join("\n");
}

describe("createRider printed day", () => {
  it("reads as one coherent rider's day (face validation)", () => {
    // The window closes a full max-ride below the horizon, so every tap-in has its
    // tap-out: the day is clean in/out pairs a human can read top to bottom.
    expect(renderDay(ride())).toMatchInlineSnapshot(`
      "t   2  IN   cen  blue    bal 955
      t 214  OUT  bay  blue    bal 955
      t 219  IN   bay  blue    bal 910
      t 432  OUT  cen  blue    bal 910
      t 437  IN   cen  blue    bal 890
      t 500  OUT  mkt  blue    bal 890
      t 505  IN   mkt  blue    bal 870
      t 568  OUT  cen  blue    bal 870
      t 571  IN   cen  blue    bal 850
      t 631  OUT  mkt  blue    bal 850"
    `);
  });
});

describe("createRider validates its tick ranges", () => {
  it("rejects a fractional range", () => {
    expect(() => createRider({ ...base, jitterTicks: { min: 1.5, max: 2 } })).toThrow(
      /jitterTicks/,
    );
  });

  it("rejects a negative range", () => {
    expect(() => createRider({ ...base, dwellTicks: { min: -1, max: 2 } })).toThrow(/dwellTicks/);
  });

  it("rejects a NaN range", () => {
    expect(() => createRider({ ...base, jitterTicks: { min: Number.NaN, max: 2 } })).toThrow(
      /jitterTicks/,
    );
  });

  it("rejects an infinite range", () => {
    expect(() =>
      createRider({ ...base, dwellTicks: { min: 0, max: Number.POSITIVE_INFINITY } }),
    ).toThrow(/dwellTicks/);
  });
});

describe("createRider validates its window", () => {
  it("rejects a NaN endTick, which would let `tick >= endTick` always fail", () => {
    expect(() => createRider({ ...base, window: { startTick: 0, endTick: Number.NaN } })).toThrow(
      /window/,
    );
  });

  it("rejects a fractional startTick", () => {
    expect(() => createRider({ ...base, window: { startTick: 1.5, endTick: 10 } })).toThrow(
      /window/,
    );
  });

  it("rejects a negative bound", () => {
    expect(() => createRider({ ...base, window: { startTick: -1, endTick: 10 } })).toThrow(
      /window/,
    );
  });

  it("rejects a startTick past its endTick", () => {
    expect(() => createRider({ ...base, window: { startTick: 10, endTick: 5 } })).toThrow(/window/);
  });

  it("accepts a valid window", () => {
    expect(() => createRider({ ...base, window: { startTick: 0, endTick: 10 } })).not.toThrow();
  });
});
