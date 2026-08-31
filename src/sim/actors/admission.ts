/**
 * The wave admission controller (issue #89). It reads the wave schedule and returns
 * the tick of every admitted arrival. Since GH102 it is the ONE benign accumulator:
 * the kiosk scenario builds its benign patron slots from this, so no second copy of
 * the accumulator math exists. Per-wave reset holds: for a whole rate the per-tick
 * count equals `eventsPerTick`; for a fractional rate the cumulative count spreads
 * evenly. Arrivals land only inside each wave's half-open `[startTick, startTick +
 * durationTicks)`, so the intro and every drain gap carry no new arrivals.
 *
 * Deterministic and pure. No rng: the accumulator alone fixes the ticks.
 */
import type { Wave } from "../scenario";
import { assertWaveScheduleOrdered } from "../wave-schedule";

/**
 * Far above any real wave rate (the shipped peak is 60). It caps `eventsPerTick`
 * so a pathological rate cannot stall the accumulator or materialize an unbounded
 * arrival array. Past `Number.MAX_SAFE_INTEGER` the `acc -= 1` step stops making
 * progress, so an unbounded rate would loop forever; this bound forbids that.
 * The shared `assertWaveScheduleOrdered` (`../wave-schedule.ts`) already rejects
 * a non-finite or negative rate; this cap is the one accumulator-specific check
 * left local to admission.
 */
const MAX_EVENTS_PER_TICK = 10_000;

/** Reject a rate above the accumulator's cap. Finiteness and sign are the shared helper's job. */
function assertRateCap(wave: Wave, index: number): void {
  if (wave.eventsPerTick > MAX_EVENTS_PER_TICK) {
    throw new Error(
      `admitArrivals: wave ${index} eventsPerTick ${wave.eventsPerTick} exceeds the ${MAX_EVENTS_PER_TICK} cap.`,
    );
  }
}

/**
 * The tick of every admitted arrival, in non-decreasing order. Each wave carries
 * its own fractional accumulator, reset at the wave's start: every tick adds
 * `eventsPerTick`, and each whole unit it crosses admits one arrival at that
 * tick. So a whole rate admits exactly `eventsPerTick` arrivals per tick, and a
 * fractional rate spreads its cumulative count evenly instead of rounding per tick
 * (the behavior the legacy kiosk draft loop had before GH102 moved it here).
 */
export function admitArrivals(waves: readonly Wave[]): number[] {
  // Field validity, chronological order, and no-overlap all live in the shared
  // helper now (F002); thrown messages come from there, which is fine since this
  // module's own tests use bare `.toThrow()`.
  assertWaveScheduleOrdered(waves);
  waves.forEach((wave, index) => {
    assertRateCap(wave, index);
  });

  const arrivals: number[] = [];
  for (const wave of waves) {
    let acc = 0;
    const endTick = wave.startTick + wave.durationTicks;
    for (let tick = wave.startTick; tick < endTick; tick++) {
      acc += wave.eventsPerTick;
      while (acc >= 1) {
        acc -= 1;
        arrivals.push(tick);
      }
    }
  }
  return arrivals;
}
