/**
 * The wave schedule: the wave ramp and its checkpoints, derived from the tuning
 * constants. Shared by every Scenario and test that needs the same arrival and
 * checkpoint boundaries (the kiosk Scenario, its winnability band, and the
 * fare-gate-rush run builder). Wave 1 follows the intro; each later wave starts
 * at the prior wave's checkpoint, so the waves are half-open and never overlap.
 * Each checkpoint sits a drain gap past its wave; the last one is the final
 * deadline. See GH3-PLAN.md section 5.3 and issue #89.
 *
 * GH124-PLAN.md Checkpoint 3 adds a second `mode`: `"steady"` builds
 * `WAVE_COUNT` CONTIGUOUS (gap 0), equal-rate waves at the calm baseline rate
 * (`WAVE_RATES[0]`) instead of the climbing ramp, with one terminal checkpoint
 * after the last arrival rather than one checkpoint per wave. `planAttacks()`
 * still gets exactly `WAVE_COUNT` waves to plan one attack batch per wave; only
 * the benign arrival shape underneath changes.
 *
 * GH126-PLAN.md M1 adds a third `mode`: `"endless"` builds NO waves and NO
 * checkpoints at all. The perpetual ambient account-rider spawner owns arrival
 * cadence for the endless baseline, not this schedule, and an empty checkpoint
 * list makes the engine's checkpoint loop inert, so the run never concludes.
 */
import {
  DRAIN_GAP_TICKS,
  INTRO_TICKS,
  WAVE_COUNT,
  WAVE_DURATION_TICKS,
  WAVE_RATES,
} from "../game/tuning";
import type { Checkpoint, ScheduleMode, Wave } from "./scenario";

/**
 * `WAVE_COUNT` contiguous equal-rate waves at the calm baseline rate, spanning
 * the run gap-free, so `admitArrivals()`'s accumulator (reset at each wave's
 * start, but always back to a whole number by a whole-rate wave's end) sees no
 * seam at any wave boundary: one gapless constant arrival stream. One terminal
 * checkpoint sits a drain allowance past the last arrival; steady runs no
 * interim wave checkpoints, since there is nothing between waves to clear.
 */
function buildSteadySchedule(): { waves: Wave[]; checkpoints: Checkpoint[] } {
  const rate = WAVE_RATES[0];
  if (rate === undefined) {
    throw new Error("buildSchedule: WAVE_RATES must carry at least one rate for steady mode.");
  }
  const waves: Wave[] = [];
  let tick = INTRO_TICKS;
  for (let i = 0; i < WAVE_COUNT; i++) {
    waves.push({ startTick: tick, durationTicks: WAVE_DURATION_TICKS, eventsPerTick: rate });
    tick += WAVE_DURATION_TICKS; // contiguous: the next wave starts exactly where this one ends
  }
  const checkpoints: Checkpoint[] = [
    { atTick: tick + DRAIN_GAP_TICKS, clearsThroughWave: WAVE_COUNT - 1 },
  ];
  return { waves, checkpoints };
}

export function buildSchedule(mode: ScheduleMode = "waves"): {
  waves: Wave[];
  checkpoints: Checkpoint[];
} {
  if (mode === "endless") {
    // No ramp, no checkpoints: the ambient account-rider spawner owns arrival
    // cadence, and an empty checkpoint list makes the checkpoint loop inert
    // (GH126-PLAN.md M1).
    return { waves: [], checkpoints: [] };
  }
  if (mode === "steady") {
    return buildSteadySchedule();
  }
  const waves: Wave[] = [];
  const checkpoints: Checkpoint[] = [];
  let start = INTRO_TICKS;
  WAVE_RATES.forEach((eventsPerTick, index) => {
    waves.push({ startTick: start, durationTicks: WAVE_DURATION_TICKS, eventsPerTick });
    const atTick = start + WAVE_DURATION_TICKS + DRAIN_GAP_TICKS;
    checkpoints.push({ atTick, clearsThroughWave: index });
    start = atTick; // the next wave starts at this checkpoint: no overlap, no gap-jump
  });
  return { waves, checkpoints };
}
