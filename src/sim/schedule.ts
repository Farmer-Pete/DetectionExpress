/**
 * The wave schedule: the wave ramp and its checkpoints, derived from the tuning
 * constants. Shared by every Scenario and test that needs the same arrival and
 * checkpoint boundaries (the kiosk Scenario, its winnability band, and the
 * fare-gate-rush run builder). Wave 1 follows the intro; each later wave starts
 * at the prior wave's checkpoint, so the waves are half-open and never overlap.
 * Each checkpoint sits a drain gap past its wave; the last one is the final
 * deadline. See GH3-PLAN.md section 5.3 and issue #89.
 */
import { DRAIN_GAP_TICKS, INTRO_TICKS, WAVE_DURATION_TICKS, WAVE_RATES } from "../game/tuning";
import type { Checkpoint, Wave } from "./scenario";

export function buildSchedule(): { waves: Wave[]; checkpoints: Checkpoint[] } {
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
