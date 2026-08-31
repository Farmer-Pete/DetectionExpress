/**
 * Burst planning and Ground truth for the pin-brute-force Scenario. Each wave
 * carries `ATTACKS_PER_WAVE[wave]` bursts (2, 4, 8), each on its own globally
 * distinct victim, so its evidence lands while the wave is active and never in a
 * drain gap. Bursts inside one wave are staggered so they spread across it; bursts
 * on distinct accounts may overlap in time, which is fair because the detector
 * counts per account. Each burst fits inside one detection window, so the rule can
 * always catch it. The scorer reads the resulting Attacks; the Rule never sees them.
 */
import { GAME_SECONDS_PER_TICK } from "../../../game/tuning";
import { type Attack, assertValidThreshold } from "../../attack";
import type { Wave } from "../../scenario";
import { ATTACKS_PER_WAVE, PIN_BRUTE_FORCE_THRESHOLD, SCAN_WINDOW_TICKS } from "./tuning";

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
 * Pick `count` distinct victims by shuffling the pool with the seeded rng. Victims
 * stay globally distinct across every wave, so no account is attacked twice.
 */
export function selectVictims(
  accounts: readonly string[],
  rng: () => number,
  count: number,
): string[] {
  const order = [...accounts];
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(rng() * (order.length - i));
    const here = order[i];
    const there = order[j];
    if (here !== undefined && there !== undefined) {
      order[i] = there;
      order[j] = here;
    }
  }
  return order.slice(0, count);
}

/**
 * Plan every wave's bursts. Wave k gets `ATTACKS_PER_WAVE[k]` bursts on the next
 * unused victims, so attack ids run 1..sum in plan order. Each burst spans the
 * lesser of the detection window and the wave, and its start tick is drawn seeded
 * from a stagger range inside the wave, so bursts in one wave spread out while every
 * failure still falls inside one window and inside the active wave. The victim pool
 * must hold at least the total burst count.
 */
export function planAttacks(
  waves: readonly Wave[],
  victims: readonly string[],
  rng: () => number,
): AttackPlan[] {
  if (ATTACKS_PER_WAVE.length !== waves.length) {
    throw new Error(
      `planAttacks: ATTACKS_PER_WAVE has ${ATTACKS_PER_WAVE.length} entries but there are ${waves.length} waves.`,
    );
  }
  const plans: AttackPlan[] = [];
  let victimIndex = 0;
  let nextId = 1;
  waves.forEach((wave, waveIndex) => {
    const burstCount = ATTACKS_PER_WAVE[waveIndex] ?? 0;
    const spanTicks = Math.min(
      SCAN_WINDOW_TICKS - BURST_MARGIN_TICKS,
      wave.durationTicks - 2 * BURST_MARGIN_TICKS,
    );
    // The range the burst's start may slide within, keeping a margin at each wave
    // end even after the span. At the shipped tuning this is 70 ticks.
    const staggerRange = wave.durationTicks - 2 * BURST_MARGIN_TICKS - spanTicks;
    if (staggerRange < 0) {
      throw new RangeError("Wave is too short to stagger a PIN brute-force burst.");
    }
    for (let b = 0; b < burstCount; b++) {
      const account = victims[victimIndex];
      victimIndex += 1;
      if (account === undefined) {
        throw new Error(
          `planAttacks: ran out of victims at wave ${waveIndex}, burst ${b}; need ${
            victimIndex
          } distinct victims.`,
        );
      }
      // Between threshold and threshold + 3 failures: always enough, sometimes more.
      const count = PIN_BRUTE_FORCE_THRESHOLD + Math.floor(rng() * 4);
      // Defensive: the shipped tuning leaves spanTicks (130) far above count - 1 (at
      // most 7), so this never fires today. It guards a future wave short enough that
      // the burst could not fit, which would make the timestamps non-increasing.
      if (spanTicks < count - 1) {
        throw new RangeError("Wave is too short to contain a PIN brute-force burst.");
      }
      const startTick =
        wave.startTick + BURST_MARGIN_TICKS + Math.floor(rng() * (staggerRange + 1));
      const gap = spanTicks / (count - 1);
      const failTimestamps: number[] = [];
      for (let k = 0; k < count; k++) {
        const tick = startTick + Math.round(k * gap);
        failTimestamps.push(tick * GAME_SECONDS_PER_TICK);
      }
      plans.push({
        id: nextId,
        account,
        window: {
          startTs: startTick * GAME_SECONDS_PER_TICK,
          endTs: (startTick + spanTicks) * GAME_SECONDS_PER_TICK,
        },
        failTimestamps,
      });
      nextId += 1;
    }
  });
  return plans;
}

/**
 * The Attack ground truth for a plan, once its failures have their Event ids.
 * Validates its own threshold before returning it (the generation seam): a bad
 * tuning value fails loudly here rather than reaching the scorer.
 */
export function attackFromPlan(plan: AttackPlan, eventIds: number[]): Attack {
  const attack: Attack = {
    id: plan.id,
    entity: plan.account,
    reason: PIN_BRUTE_FORCE_REASON,
    window: plan.window,
    eventIds,
    // Per-attack scoring (GH42-PLAN.md): this hunt's own threshold, read by the
    // scorer instead of a global config value, so a mixed run scores each hunt
    // by its own evidence bar.
    threshold: PIN_BRUTE_FORCE_THRESHOLD,
  };
  assertValidThreshold(attack);
  return attack;
}
