/**
 * The account rider: a transient `Actor<WorldReading, WorldEnv>` that visits a
 * station's account kiosk, signs in benignly, and leaves. It emits exactly one
 * `AccountKioskReading` with `outcome: "success"` at its station's kiosk terminal
 * (a deterministic id like `K1`), lingers `at` the station for a short dwell, then
 * despawns.
 *
 * It is benign by construction: there is no failure branch, so it NEVER fails a PIN
 * (the `wrong_pin` outcome is a later attack ticket, out of scope). It reads no env
 * and draws no rng of its own; the scheduler owns its next tick. No wall clock, no
 * React (ADR-0007, ARCHITECTURE rule 8).
 */
import { GAME_SECONDS_PER_TICK } from "../../game/tuning";
import type { Presence } from "../world/presence";
import type { WorldEnv, WorldReading } from "../world-reading";
import type { Actor } from "./actor";

/** One account rider's configuration: who signs in, where, and how long it lingers. */
export interface AccountRiderConfig {
  /** The actor id, minted fresh per birth (never reused). Distinct from the account. */
  id: string;
  /** The login username signing in, e.g. `"river.k"`. */
  account: string;
  /** The station whose kiosk it uses. */
  station: string;
  /** The kiosk terminal id it signs in at, e.g. `"K1"`. */
  terminal: string;
  /** The tick it first acts (signs in), phased by the spawner. */
  startTick: number;
  /** Ticks it lingers `at` the kiosk after signing in, before it despawns (> 0). */
  dwellTicks: number;
}

/**
 * The presence a freshly admitted account rider carries before its first act:
 * standing `at` its station until it signs in. The engine builds it from the first
 * tick the schedule returns at admission.
 */
export function initialAccountRiderPresence(station: string, firstTick: number): Presence {
  return { kind: "at", node: station, fromTick: firstTick, untilTick: firstTick };
}

/** The account rider's FSM phase: signing in at the kiosk, or leaving. */
type Phase = { kind: "signin" } | { kind: "leaving" };

/**
 * Build one transient account rider over its config. The returned actor holds its own
 * FSM state; the scheduler owns its next tick. It emits one benign kiosk `success`
 * reading on sign-in and reports a presence the view interpolates: `at` the station
 * while it is at the kiosk.
 */
export function createAccountRider(config: AccountRiderConfig): Actor<WorldReading, WorldEnv> {
  let phase: Phase = { kind: "signin" };

  /** The one benign kiosk sign-in `WorldReading` at `tick`, in the game-second domain. */
  const signin = (tick: number): WorldReading => ({
    sensor: "kiosk",
    reading: {
      ts: tick * GAME_SECONDS_PER_TICK,
      account: config.account,
      station: config.station,
      terminal: config.terminal,
      outcome: "success",
    },
  });

  return {
    id: config.id,
    start: () => config.startTick,
    act: ({ tick }) => {
      if (phase.kind === "signin") {
        // Sign in benignly, then linger `at` the station kiosk for the dwell.
        const nextTick = tick + config.dwellTicks;
        phase = { kind: "leaving" };
        return {
          readings: [signin(tick)],
          nextTick,
          presence: { kind: "at", node: config.station, fromTick: tick, untilTick: nextTick },
        };
      }
      // LEAVING: the dwell has elapsed; the account rider despawns.
      return { readings: [], nextTick: "dormant" };
    },
  };
}
