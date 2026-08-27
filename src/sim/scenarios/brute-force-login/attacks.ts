/**
 * Burst planning and Ground truth for the brute-force-login Scenario. Victims are
 * preselected and each gets one non-overlapping window, so a victim's traffic is
 * known before any benign Event is drawn. The scorer reads the resulting Attacks;
 * the Rule never sees them.
 */
import type { Attack } from "../../attack";

/** The pattern this Scenario reveals. Both the ground truth and the reference use it. */
export const BRUTE_FORCE_REASON = "brute_force";

/** One planned burst: its account, its window, and the failure times inside it. */
export interface AttackPlan {
  id: number;
  account: string;
  window: { startTs: number; endTs: number };
  /** Strictly increasing game-second times, at least the threshold of them. */
  failTimestamps: number[];
}

/** Inputs the planner needs from the Scenario's tuning. */
export interface PlanConfig {
  /** Timeline length in game seconds. Every window ends before this. */
  timelineSeconds: number;
  /** The detection window in game seconds; a burst spans well under it. */
  windowSeconds: number;
  /** Minimum failures a burst carries. */
  threshold: number;
}

/**
 * Plan one burst per victim. The timeline is cut into one slot per victim so the
 * windows never overlap, and each burst sits early in its slot with room to
 * spare, so every window ends before the timeline does.
 */
export function planAttacks(
  victims: readonly string[],
  rng: () => number,
  config: PlanConfig,
): AttackPlan[] {
  const slot = config.timelineSeconds / victims.length;
  // Keep the burst inside its slot and well under the detection window, so the
  // reference always sees the whole burst within one window.
  const span = Math.min(config.windowSeconds - 60, slot - 40);
  const margin = 20;

  const plans: AttackPlan[] = [];
  victims.forEach((account, index) => {
    // Between threshold and threshold + 3 failures: always enough, sometimes more.
    const extra = Math.floor(rng() * 4);
    const count = config.threshold + extra;
    const base = index * slot + margin;
    const gap = span / (count - 1);
    const failTimestamps: number[] = [];
    for (let k = 0; k < count; k++) {
      failTimestamps.push(Math.round(base + k * gap));
    }
    // The evenly-spaced burst starts at `base` and ends one full span later.
    plans.push({
      id: index + 1,
      account,
      window: { startTs: Math.round(base), endTs: Math.round(base + span) },
      failTimestamps,
    });
  });
  return plans;
}

/** The Attack ground truth for a plan, once its failures have their Event ids. */
export function attackFromPlan(plan: AttackPlan, eventIds: number[]): Attack {
  return {
    id: plan.id,
    account: plan.account,
    reason: BRUTE_FORCE_REASON,
    window: plan.window,
    eventIds,
  };
}
