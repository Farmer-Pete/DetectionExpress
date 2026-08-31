/**
 * The PIN attacker: a coordinated attacker modeled as one world actor
 * (`Actor<WorldReading, WorldEnv>`, ADR-0007 decision 5). It arrives at its
 * victim's station a fixed lead before the burst (presence only, no reading),
 * plays the plan's `failTimestamps` as wrong-PIN kiosk fails at one terminal, then
 * goes dormant (departure IS dormancy; `Presence` has no "off" variant). Account
 * kiosks sit outside the paid area, so it never taps a fare gate.
 *
 * Invariant: every reading this actor emits is attack evidence — one kiosk `fail`
 * per planned timestamp, and nothing else. It reads no env and draws no rng; the
 * plan fixes the account, the terminal, and every fail time, so `planAttacks`
 * stays the sole source of timing and ground truth. No wall clock, no React
 * (ARCHITECTURE rule 8).
 */
import { GAME_SECONDS_PER_TICK } from "../../../game/tuning";
import type { Actor } from "../../actors/actor";
import type { Presence } from "../../world/presence";
import type { WorldEnv, WorldReading } from "../../world-reading";

/**
 * Ticks the attacker arrives before its first fail. Both callers and the corpus
 * span proof read it; the proof needs the lead <= 42. A start tick is the first
 * fail tick minus this, so a first fail must be at least this many ticks in.
 */
export const ARRIVE_LEAD_TICKS = 20;

/** One PIN attacker's plan: who it targets, where, and the exact fail times. */
export interface PinAttackerConfig {
  /** The actor id, minted per attack (never reused). Distinct from the account. */
  id: string;
  /** The victim login the attacker hammers, e.g. `"river.k"`. */
  account: string;
  /** The station whose kiosk it attacks. */
  station: string;
  /** The kiosk terminal id it fails at, e.g. `"K1"`. */
  terminal: string;
  /**
   * The wrong-PIN times, in game seconds, strictly increasing. Each must be a whole
   * tick (divisible by `GAME_SECONDS_PER_TICK`), and the first must be at least
   * `ARRIVE_LEAD_TICKS` ticks in, so the arrival tick is never negative.
   */
  failTimestamps: number[];
}

/** The attacker's FSM phase: arriving at the station, or playing its fails. */
type Phase = { kind: "arrive" } | { kind: "failing"; index: number };

/**
 * Build one PIN attacker over its config. Validates the plan up front (both callers
 * satisfy these by construction) and returns an actor that emits one kiosk `fail`
 * per fail tick, then goes dormant. It reports a presence the view interpolates:
 * `at` the station from arrival through the last fail.
 */
export function createPinAttacker(config: PinAttackerConfig): Actor<WorldReading, WorldEnv> {
  const { failTimestamps } = config;
  if (failTimestamps.length === 0) {
    throw new Error(`createPinAttacker: "${config.id}" has no fail timestamps.`);
  }
  const failTicks: number[] = [];
  for (let i = 0; i < failTimestamps.length; i++) {
    const ts = failTimestamps[i] ?? 0;
    if (ts % GAME_SECONDS_PER_TICK !== 0) {
      throw new Error(
        `createPinAttacker: "${config.id}" fail time ${ts} is not a whole tick ` +
          `(divisible by ${GAME_SECONDS_PER_TICK}).`,
      );
    }
    const prior = failTimestamps[i - 1];
    if (prior !== undefined && ts <= prior) {
      throw new Error(
        `createPinAttacker: "${config.id}" fail times are not strictly increasing (${prior} then ${ts}).`,
      );
    }
    failTicks.push(ts / GAME_SECONDS_PER_TICK);
  }
  const firstFailTick = failTicks[0] ?? 0;
  if (firstFailTick < ARRIVE_LEAD_TICKS) {
    throw new Error(
      `createPinAttacker: "${config.id}" first fail at tick ${firstFailTick} is inside the ` +
        `${ARRIVE_LEAD_TICKS}-tick arrival lead, so the start tick would be negative.`,
    );
  }

  let phase: Phase = { kind: "arrive" };

  /** One wrong-PIN kiosk `WorldReading` at `tick`, in the game-second domain. */
  const fail = (tick: number): WorldReading => ({
    sensor: "kiosk",
    reading: {
      ts: tick * GAME_SECONDS_PER_TICK,
      account: config.account,
      station: config.station,
      terminal: config.terminal,
      outcome: "fail",
    },
  });

  const atStation = (fromTick: number, untilTick: number): Presence => ({
    kind: "at",
    node: config.station,
    fromTick,
    untilTick,
  });

  return {
    id: config.id,
    start: () => firstFailTick - ARRIVE_LEAD_TICKS,
    act: ({ tick }) => {
      if (phase.kind === "arrive") {
        // Presence only: stand at the station until the first fail. No reading.
        phase = { kind: "failing", index: 0 };
        return { readings: [], nextTick: firstFailTick, presence: atStation(tick, firstFailTick) };
      }
      // FAILING: emit this fail, then move to the next fail tick or go dormant.
      const nextIndex = phase.index + 1;
      const nextFailTick = failTicks[nextIndex];
      if (nextFailTick !== undefined) {
        phase = { kind: "failing", index: nextIndex };
        return {
          readings: [fail(tick)],
          nextTick: nextFailTick,
          presence: atStation(tick, nextFailTick),
        };
      }
      // The final fail: emit it, then depart (dormancy).
      return { readings: [fail(tick)], nextTick: "dormant", presence: atStation(tick, tick) };
    },
  };
}
