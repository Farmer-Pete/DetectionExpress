/**
 * The fare-gate-rush run entry point (GH89-PLAN.md section 7). Turns benign rider
 * traffic into a `GeneratedRun` from code: the wave schedule sets the arrival
 * ticks, one single-trip rider fills each arrival slot, the heap scheduler runs
 * them, and the composer sorts their tap-in/tap-out readings into events. Not a
 * registered Scenario: no Hunt, no Attack, no UI entry. `attacks` is always `[]`.
 *
 * The sim stays pure here too: no React, no DOM, no wall clock. Every draw comes
 * from the seeded `rng` or the seeded `faker`, so the same seed always replays
 * the same run.
 */
import { en, Faker } from "@faker-js/faker";
import { randomLcg } from "d3-random";
import { DRAIN_GAP_TICKS, GAME_SECONDS_PER_TICK } from "../../../game/tuning";
import { minutesToTicks, runActors } from "../../actors/actor";
import { admitArrivals } from "../../actors/admission";
import { composeRun } from "../../actors/compose";
import { createRider } from "../../actors/rider";
import { gatekeepGate } from "../../endpoints/fare-gate/gatekeep";
import type { Checkpoint, GeneratedRun } from "../../scenario";
import { buildSchedule } from "../../schedule";
import { distanceTable, sharedLineRoute } from "../../world/distance";
import { world } from "../../world/world";

/** The fare law this run charges: `fare = base + perMinute * distanceMinutes`. Whole units. */
const FARE_BASE = 2;
const FARE_PER_MINUTE = 1;

/** Extra ride ticks beyond the travel time, so a ride is at least the distance. */
const JITTER_TICKS = { min: 0, max: 5 };

/**
 * The longest direct, single-line ride in the world, in minutes, and the world's
 * most expensive such ride's fare. Computed once over every station pair that
 * shares a line; a rider never rides a route that needs a transfer.
 */
function worldRideExtremes(): { longestMinutes: number; maxFare: number } {
  let longestMinutes = 0;
  for (const from of world.stations) {
    for (const to of world.stations) {
      if (from.id === to.id) {
        continue;
      }
      const route = sharedLineRoute(world, from.id, to.id);
      if (route !== null) {
        longestMinutes = Math.max(longestMinutes, route.minutes);
      }
    }
  }
  const maxFare = FARE_BASE + FARE_PER_MINUTE * longestMinutes;
  return { longestMinutes, maxFare };
}

/** A pool of `count` distinct card ids, drawn from the seeded faker. */
function buildCardPool(faker: Faker, count: number): string[] {
  const cards = new Set<string>();
  while (cards.size < count) {
    cards.add(faker.finance.creditCardNumber());
  }
  return [...cards];
}

/**
 * A defensive invariant: every admitted card taps in exactly once, then out
 * exactly once, before the scheduler's horizon closes it out. A violation here is
 * a generation bug (a rider left riding, or a rider that never affords its trip),
 * so it fails loudly rather than reaching a player as an incoherent run.
 */
function assertEveryTripCloses(
  readings: readonly { card: string; direction: "in" | "out" }[],
  cardCount: number,
): void {
  const byCard = new Map<string, ("in" | "out")[]>();
  for (const reading of readings) {
    const list = byCard.get(reading.card) ?? [];
    list.push(reading.direction);
    byCard.set(reading.card, list);
  }
  if (byCard.size !== cardCount) {
    throw new Error(
      `fare-gate-rush: expected ${cardCount} riders to complete a trip, got ${byCard.size}.`,
    );
  }
  for (const [card, directions] of byCard) {
    if (directions.length !== 2 || directions[0] !== "in" || directions[1] !== "out") {
      throw new Error(`fare-gate-rush: card ${card} did not tap in once then out once.`);
    }
  }
}

/** Extend the final checkpoint's tick to the data-derived deadline. Every prior checkpoint is unchanged. */
function withFinalDeadline(
  checkpoints: readonly Checkpoint[],
  finalDeadline: number,
): Checkpoint[] {
  const last = checkpoints[checkpoints.length - 1];
  if (last === undefined) {
    return [...checkpoints];
  }
  const extended = checkpoints.slice(0, -1);
  extended.push({ atTick: finalDeadline, clearsThroughWave: last.clearsThroughWave });
  return extended;
}

export function buildFareGateRun(seed: number): GeneratedRun {
  const distances = distanceTable(world);
  const { waves, checkpoints } = buildSchedule();
  const arrivalTicks = admitArrivals(waves);

  const faker = new Faker({ locale: en });
  faker.seed(seed);
  const rng = randomLcg(seed);

  const cards = buildCardPool(faker, arrivalTicks.length);
  const stationIds = world.stations.map((station) => station.id);
  const { longestMinutes, maxFare } = worldRideExtremes();

  const riders = arrivalTicks.map((tick, index) => {
    const card = cards[index];
    const origin = stationIds[Math.floor(rng() * stationIds.length)];
    if (card === undefined || origin === undefined) {
      throw new Error("fare-gate-rush: exhausted the seeded card or station pool.");
    }
    return createRider({
      card,
      origin,
      balance: maxFare,
      window: { startTick: tick, endTick: tick + 1 },
      fare: { base: FARE_BASE, perMinute: FARE_PER_MINUTE },
      jitterTicks: JITTER_TICKS,
      dwellTicks: { min: 0, max: 0 },
    });
  });

  // Generous upper bound: the last possible arrival plus the longest possible
  // ride, plus one so the half-open horizon does not exclude that exact tick.
  // Overshooting is free: the scheduler stops once no actor remains.
  const lastWave = waves[waves.length - 1];
  const lastArrival = lastWave === undefined ? 0 : lastWave.startTick + lastWave.durationTicks - 1;
  const longestRideTicks = minutesToTicks(longestMinutes) + JITTER_TICKS.max;
  const horizon = lastArrival + longestRideTicks + 1;

  const readings = runActors({
    actors: riders,
    env: { world, distances },
    runSeed: seed,
    horizon,
  });
  assertEveryTripCloses(readings, riders.length);

  const { events, attacks } = composeRun({
    readings,
    tsOf: (reading) => reading.ts,
    format: (reading) => gatekeepGate.format(reading),
    endpointId: gatekeepGate.id,
  });

  const lastEventTs = events.reduce((max, event) => Math.max(max, event.ts), 0);
  const lastEventTick = lastEventTs / GAME_SECONDS_PER_TICK;
  const finalDeadline = lastEventTick + 1 + DRAIN_GAP_TICKS;

  return { events, attacks, checkpoints: withFinalDeadline(checkpoints, finalDeadline) };
}
