/**
 * Burst planning and Ground truth for the kiosk-pin-attack Scenario. One Attack
 * sits inside each wave, on a distinct victim, so its evidence lands while the
 * wave is active and never in a drain gap. Each burst fits inside one detection
 * window, so the rule can always catch it. The scorer reads the resulting Attacks;
 * the Rule never sees them.
 */
import {
  GAME_SECONDS_PER_TICK,
  PIN_BRUTE_FORCE_THRESHOLD,
  SCAN_WINDOW_TICKS,
} from "../../../game/tuning";
import type { Attack } from "../../attack";
import type { Wave } from "../../scenario";

/** The pattern this Scenario reveals. Both the ground truth and the reference use it. */
export const PIN_BRUTE_FORCE_REASON = "pin_brute_force";

/** One planned burst: its account, its window, and the failure times inside it. */
export interface AttackPlan {
  id: number;
  account: string;
  window: { startTs: number; endTs: number };
  /** Strictly increasing game-second times, at least the threshold of them. */
  failTimestamps: number[];
}

/** Ticks of clearance the burst leaves at each end of its wave. */
const BURST_MARGIN_TICKS = 20;

/**
 * Plan one burst per wave. The burst starts a margin into the wave and spans the
 * lesser of the detection window and the wave, so every failure falls inside one
 * window and inside the active wave. A wave with no victim (fewer victims than
 * waves) gets no burst.
 */
export function planAttacks(
  waves: readonly Wave[],
  victims: readonly string[],
  rng: () => number,
): AttackPlan[] {
  const plans: AttackPlan[] = [];
  waves.forEach((wave, index) => {
    const account = victims[index];
    if (account === undefined) {
      return;
    }
    // Between threshold and threshold + 3 failures: always enough, sometimes more.
    const count = PIN_BRUTE_FORCE_THRESHOLD + Math.floor(rng() * 4);
    const spanTicks = Math.min(
      SCAN_WINDOW_TICKS - BURST_MARGIN_TICKS,
      wave.durationTicks - 2 * BURST_MARGIN_TICKS,
    );
    // Defensive: the shipped tuning leaves spanTicks (130) far above count - 1
    // (at most 7), so this never fires today. It guards a future wave short enough
    // that the burst could not fit, which would make the timestamps non-increasing
    // and reverse the Attack window.
    if (spanTicks < count - 1) {
      throw new RangeError("Wave is too short to contain a PIN brute-force burst.");
    }
    const startTick = wave.startTick + BURST_MARGIN_TICKS;
    const gap = spanTicks / (count - 1);
    const failTimestamps: number[] = [];
    for (let k = 0; k < count; k++) {
      const tick = startTick + Math.round(k * gap);
      failTimestamps.push(tick * GAME_SECONDS_PER_TICK);
    }
    plans.push({
      id: index + 1,
      account,
      window: {
        startTs: startTick * GAME_SECONDS_PER_TICK,
        endTs: (startTick + spanTicks) * GAME_SECONDS_PER_TICK,
      },
      failTimestamps,
    });
  });
  return plans;
}

/** The Attack ground truth for a plan, once its failures have their Event ids. */
export function attackFromPlan(plan: AttackPlan, eventIds: number[]): Attack {
  return {
    id: plan.id,
    entity: plan.account,
    reason: PIN_BRUTE_FORCE_REASON,
    window: plan.window,
    eventIds,
  };
}
