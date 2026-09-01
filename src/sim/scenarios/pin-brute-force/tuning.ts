/**
 * This scenario's own tuning constants (GH42-PLAN.md "Tuning co-location"). They
 * used to live in the global `game/tuning.ts` alongside every other slice's
 * numbers; they move here because they belong to pin-brute-force alone, not to
 * the cross-cutting clock, wave shape, or service math every scenario shares.
 * `GAME_SECONDS_PER_TICK` (the one cross-cutting constant this file reads, to
 * derive `SCAN_WINDOW_TICKS`) stays in `game/tuning.ts`.
 */
import { GAME_SECONDS_PER_TICK } from "../../../game/tuning";

/** Wrong PINs within the window that flag a PIN brute-force Attack. */
export const PIN_BRUTE_FORCE_THRESHOLD = 5;

/** The PIN brute-force detection window, in game seconds (5 minutes). */
export const PIN_BRUTE_FORCE_WINDOW_S = 300;

/**
 * How many PIN-brute-force bursts each wave carries, indexed by wave (GH102). The
 * pressure climbs 2 -> 4 -> 8, so a wave holds more than one attack, on that many
 * globally distinct victims. Its length must equal the wave count; `planAttacks`
 * throws otherwise. The total (14) is the victim count `selectVictims` draws.
 */
export const ATTACKS_PER_WAVE: readonly number[] = [2, 4, 8];

/** The detection window in ticks (300 game seconds). The naive scan evicts past it. */
export const SCAN_WINDOW_TICKS = PIN_BRUTE_FORCE_WINDOW_S / GAME_SECONDS_PER_TICK;
