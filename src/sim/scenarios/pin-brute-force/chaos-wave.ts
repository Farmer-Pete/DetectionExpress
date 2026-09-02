/**
 * The chaos-wave planning seam (GH126-PLAN.md M2a item 3, Codex N4, revised). Mints a
 * RANDOM 2 to 8 PIN attackers, each on a DISTINCT victim drawn from the attack
 * account namespace, each its own fail burst above threshold, all sharing ONE
 * detection window, rebased to a live trigger tick and independent of `planAttacks`'s
 * three-wave escalation. Reuses the same pin-attacker actor, victim-selection
 * (`selectVictims`), and attacker assembly (`assembleAttacker`) primitives the
 * three-wave path uses, so the two paths share one mechanism rather than diverging.
 *
 * The engine caller (M2b) admits each `attacker` through `schedule.admit()`, calls
 * `scorer.addAttack(...)` per attacker with its `victim`/`window`/`threshold` BEFORE
 * any evidence exists, then binds each fail's global event id as it is offered
 * (`scorer.bindEvidence`). The scorer's dynamic seam (`addAttack` + `bindEvidence`)
 * is the sole ground truth for a live wave, so no canonical `Attack` object is ever
 * composed: `evidenceCount` tells the caller how many fails to expect per attacker,
 * and the distinct-evidence-vs-threshold invariant is asserted here at plan time (the
 * check that once lived on the removed `toAttack`, Codex N3).
 */
import { GAME_SECONDS_PER_TICK } from "../../../game/tuning";
import { ATTACK_ACCOUNT_NAMESPACE } from "../../actors/account-namespace";
import type { ActorDescriptor } from "../../actors/actor";
import { KIOSK_TERMINALS } from "../../endpoints/kiosk/internal";
import { world } from "../../world/world";
import type { WorldEnv, WorldReading } from "../../world-reading";
import { selectVictims } from "./attacks";
import { assembleAttacker, pickSeeded } from "./cast";
import { ARRIVE_LEAD_TICKS } from "./pin-attacker";
import { PIN_BRUTE_FORCE_THRESHOLD, SCAN_WINDOW_TICKS } from "./tuning";

/**
 * Ticks of clearance the burst's detection window leaves after its last fail, so
 * the window strictly contains the burst with room to spare. Mirrors `attacks.ts`'s
 * own `BURST_MARGIN_TICKS`. Exported so the test can assert the margin directly
 * rather than hardcoding its value.
 */
export const CHAOS_WAVE_MARGIN_TICKS = 20;

/** The fewest attackers one chaos wave launches. */
export const CHAOS_WAVE_MIN_ATTACKERS = 2;

/** The most attackers one chaos wave launches. */
export const CHAOS_WAVE_MAX_ATTACKERS = 8;

/** One attacker in a planned chaos wave: its actor, victim, and evidence burst size. */
export interface ChaosWaveAttacker {
  /** This attacker's actor descriptor. The caller admits it through `schedule.admit()`. */
  attacker: ActorDescriptor<WorldReading, WorldEnv>;
  /** The actor id, minted by the caller through `actorIdFor` (the engine owns id policy). */
  actorId: string;
  /** This attacker's victim account, drawn from the attack namespace, disjoint from benign. */
  victim: string;
  /**
   * How many wrong-PIN fails this attacker emits — one distinct scored event each,
   * always at or above `threshold`. The caller tracks its bound-evidence count
   * against this to time the wave's drain watermark. Asserted `>= threshold` at plan
   * time (the distinct-evidence check the removed `toAttack` used to carry, Codex N3).
   */
  evidenceCount: number;
}

/** One planned chaos wave: its 2 to 8 attackers, their shared window, and the threshold. */
export interface ChaosWavePlan {
  /** The 2 to 8 attackers, each on a distinct victim. The caller admits each in order. */
  attackers: ChaosWaveAttacker[];
  /** The one detection window every attacker shares, rebased to the trigger tick. */
  window: { startTs: number; endTs: number };
  /** This hunt's evidence threshold (`PIN_BRUTE_FORCE_THRESHOLD`), shared by all attackers. */
  threshold: number;
}

/**
 * Plan one chaos wave: a random `CHAOS_WAVE_MIN_ATTACKERS`..`CHAOS_WAVE_MAX_ATTACKERS`
 * attackers, each on a distinct victim from the attack namespace, each a PIN fail
 * burst at or above threshold, ALL sharing the one detection window rebased to
 * `triggerTick`. Independent of `planAttacks`'s three-wave escalation. Each attacker's
 * `actorId` is minted by the caller through `actorIdFor` (the engine owns actor-id
 * policy, e.g. a WaveId-derived name); this seam only plans the bursts.
 */
export function planChaosWave(
  triggerTick: number,
  actorIdFor: (index: number) => string,
  rng: () => number,
): ChaosWavePlan {
  if (!Number.isInteger(triggerTick) || triggerTick < 0) {
    throw new Error(
      `planChaosWave: triggerTick must be a non-negative integer, got ${triggerTick}.`,
    );
  }

  // A random integer in [MIN, MAX], derived from the two named bounds.
  const range = CHAOS_WAVE_MAX_ATTACKERS - CHAOS_WAVE_MIN_ATTACKERS + 1;
  const count = CHAOS_WAVE_MIN_ATTACKERS + Math.floor(rng() * range);

  // Distinct victims, one per attacker. The namespace holds 64 accounts, so up to 8
  // distinct always draws cleanly; guard the invariant rather than assume it.
  const victims = selectVictims(ATTACK_ACCOUNT_NAMESPACE, rng, count);
  if (victims.length < count) {
    throw new Error(
      `planChaosWave: the attack namespace yielded ${victims.length} distinct victims, ` +
        `fewer than the ${count} attackers this wave needs.`,
    );
  }

  // The one window every attacker shares: same start and span for the whole wave.
  // The window itself spans the FULL detection window; only the burst's fail spread
  // (`burstSpanTicks`, below) is shortened, so the last fail lands with
  // `CHAOS_WAVE_MARGIN_TICKS` of clearance before the window closes.
  const startTick = triggerTick + ARRIVE_LEAD_TICKS;
  const burstSpanTicks = SCAN_WINDOW_TICKS - CHAOS_WAVE_MARGIN_TICKS;
  const window = {
    startTs: startTick * GAME_SECONDS_PER_TICK,
    endTs: (startTick + SCAN_WINDOW_TICKS) * GAME_SECONDS_PER_TICK,
  };

  const attackers: ChaosWaveAttacker[] = [];
  for (let i = 0; i < count; i++) {
    const victim = victims[i];
    if (victim === undefined) {
      throw new Error(`planChaosWave: missing victim for attacker ${i}.`);
    }
    const station = pickSeeded(
      world.stations.map((s) => s.id),
      rng,
    );
    const terminal = pickSeeded(KIOSK_TERMINALS, rng);

    // Between threshold and threshold + 3 fails, mirroring `planAttacks`'s own burst draw.
    const burst = PIN_BRUTE_FORCE_THRESHOLD + Math.floor(rng() * 4);
    // The distinct-evidence invariant, asserted at plan time now that no `toAttack`
    // composes a canonical Attack downstream: every fail is one distinct scored id, so
    // `burst` IS the distinct evidence count, and a burst below threshold could never
    // be caught (Codex N3). `burst`'s own draw keeps it `>= threshold`; this guards a
    // future change to that draw.
    if (burst < PIN_BRUTE_FORCE_THRESHOLD) {
      throw new Error(
        `planChaosWave: a ${burst}-fail burst is below the threshold of ` +
          `${PIN_BRUTE_FORCE_THRESHOLD}, so no Alert could ever catch it.`,
      );
    }
    if (burstSpanTicks < burst - 1) {
      throw new RangeError("planChaosWave: the detection window is too short for the burst.");
    }

    const gap = burst > 1 ? burstSpanTicks / (burst - 1) : 0;
    const failTimestamps: number[] = [];
    for (let k = 0; k < burst; k++) {
      const tick = startTick + Math.round(k * gap);
      failTimestamps.push(tick * GAME_SECONDS_PER_TICK);
    }

    // `attackId: 0` is a placeholder: this seam discards `assembleAttacker`'s label
    // tuple (the batch composer's actor-id -> attack-id ground-truth attribution),
    // since the live engine attributes evidence directly through
    // `scorer.bindEvidence`, never through `attackIdOf`/labels.
    const { descriptor } = assembleAttacker({
      id: actorIdFor(i),
      attackId: 0,
      account: victim,
      station,
      terminal,
      failTimestamps,
    });

    attackers.push({
      attacker: descriptor,
      actorId: actorIdFor(i),
      victim,
      evidenceCount: burst,
    });
  }

  return {
    attackers,
    window,
    threshold: PIN_BRUTE_FORCE_THRESHOLD,
  };
}
