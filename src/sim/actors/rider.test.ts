import { describe, expect, it } from "vitest";
import { GAME_SECONDS_PER_TICK } from "../../game/tuning";
import { distanceMinutes, distanceTable } from "../world/distance";
import { world } from "../world/world";
import { minutesToTicks, runActors } from "./actor";
import { createRider } from "./rider";

const distances = distanceTable(world);
const env = { world, distances };

/** A well-funded rider starting at the network's busiest interchange. */
const base = {
  card: "C09",
  origin: "cen",
  balance: 1000,
  window: { startTick: 0, endTick: 1000 },
  fare: { base: 10, perMinute: 5 },
  jitterTicks: { min: 0, max: 4 },
  dwellTicks: { min: 2, max: 6 },
};

function ride(over: Partial<typeof base> = {}) {
  const rider = createRider({ ...base, ...over });
  return runActors({ actors: [rider], env, runSeed: 4242, horizon: 1000 });
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
