/**
 * The wave admission controller (issue #89). It reads the wave
 * schedule and returns the tick of every admitted arrival. It reproduces the
 * kiosk benign accumulator exactly, including the per-wave reset: for a whole
 * rate the per-tick count equals `eventsPerTick`; for a fractional rate it
 * matches the kiosk generator's cumulative count, spread the same way. Arrivals
 * land only inside each wave's half-open `[startTick, startTick + durationTicks)`,
 * so the intro and every drain gap carry no new arrivals.
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
 */
const MAX_EVENTS_PER_TICK = 10_000;

/** Reject a wave whose bounds are not non-negative integers, so every emitted tick stays whole. */
function assertTickBounds(wave: Wave, index: number): void {
  if (!Number.isInteger(wave.startTick) || wave.startTick < 0) {
    throw new Error(`admitArrivals: wave ${index} startTick must be a non-negative integer.`);
  }
  if (!Number.isInteger(wave.durationTicks) || wave.durationTicks < 0) {
    throw new Error(`admitArrivals: wave ${index} durationTicks must be a non-negative integer.`);
  }
}

/**
 * Reject a rate that is not finite and non-negative. A non-finite rate would
 * loop forever in the accumulator below, so this throws before that can happen.
 */
function assertRate(wave: Wave, index: number): void {
  if (!Number.isFinite(wave.eventsPerTick) || wave.eventsPerTick < 0) {
    throw new Error(
      `admitArrivals: wave ${index} eventsPerTick must be a finite, non-negative number.`,
    );
  }
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
 * fractional rate spreads its cumulative count the same way the kiosk benign
 * generator does.
 */
export function admitArrivals(waves: readonly Wave[]): number[] {
  waves.forEach((wave, index) => {
    assertTickBounds(wave, index);
    assertRate(wave, index);
  });
  assertWaveScheduleOrdered(waves);

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
