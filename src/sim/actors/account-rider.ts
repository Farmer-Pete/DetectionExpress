/**
 * The account rider: a transient `Actor<WorldReading, WorldEnv>` that visits a
 * station's account kiosk, signs in, and leaves. It emits `fumbleFails` benign
 * `fail` readings (a mistyped PIN) then one `success` reading, all one
 * `AccountKioskReading` at its station's kiosk terminal (a deterministic id like
 * `K1`) at the sign-in tick, lingers `at` the station for a short dwell, then
 * despawns.
 *
 * A fumble is benign by construction, not an attack: `fumbleFails` is capped at 2,
 * and the cast budgeter keeps at most two fails per account per fixed 150-tick
 * bucket, so a rolling detection window sees at most 4 benign fails, below the
 * threshold of 5. Omit `fumbleFails` (or pass 0) and the rider emits the single
 * success it always did, byte for byte. It reads no env and draws no rng of its
 * own; the scheduler owns its next tick, and the cast fixes the fumble count. No
 * wall clock, no React (ADR-0007, ARCHITECTURE rule 8).
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
  /**
   * Benign wrong-PIN fails emitted before the success, at the sign-in tick (default
   * 0). Capped at 2 so a rider can never reach the brute-force threshold on its own;
   * the cast budgeter fixes the value per visit.
   */
  fumbleFails?: 0 | 1 | 2;
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
 * FSM state; the scheduler owns its next tick. On sign-in it emits its `fumbleFails`
 * benign kiosk `fail` readings then one `success` reading, all at the sign-in tick,
 * and reports a presence the view interpolates: `at` the station while it is at the
 * kiosk.
 */
export function createAccountRider(config: AccountRiderConfig): Actor<WorldReading, WorldEnv> {
  let phase: Phase = { kind: "signin" };
  const fumbleFails = config.fumbleFails ?? 0;

  /** One kiosk `WorldReading` at `tick`, in the game-second domain, with the given outcome. */
  const kiosk = (tick: number, outcome: "success" | "fail"): WorldReading => ({
    sensor: "kiosk",
    reading: {
      ts: tick * GAME_SECONDS_PER_TICK,
      account: config.account,
      station: config.station,
      terminal: config.terminal,
      outcome,
    },
  });

  return {
    id: config.id,
    start: () => config.startTick,
    act: ({ tick }) => {
      if (phase.kind === "signin") {
        // Fumble the PIN `fumbleFails` times, then sign in, all at this tick, in
        // emission order (the composer's stable sort keeps it). Then linger `at` the
        // station kiosk for the dwell.
        const nextTick = tick + config.dwellTicks;
        phase = { kind: "leaving" };
        const readings: WorldReading[] = [];
        for (let i = 0; i < fumbleFails; i++) {
          readings.push(kiosk(tick, "fail"));
        }
        readings.push(kiosk(tick, "success"));
        return {
          readings,
          nextTick,
          presence: { kind: "at", node: config.station, fromTick: tick, untilTick: nextTick },
        };
      }
      // LEAVING: the dwell has elapsed; the account rider despawns.
      return { readings: [], nextTick: "dormant" };
    },
  };
}
