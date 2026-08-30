/**
 * The metro staff member: a transient `Actor<WorldReading, WorldEnv>` that walks from
 * a location's nearest station to the location, crosses that location's zones LOW TO
 * HIGH, and taps the door reader at each door whose zone sits within its badge grade,
 * in ascending zone order, emitting a `door-reader` grant per door. Then it walks back
 * out and despawns.
 *
 * This is the ADR-0007 "traversal coherence" for a benign credential: every grant is
 * within grade (the badge's ceiling) and the zone crossings are strictly ascending,
 * never skipping. It reads the location's real doors from `env.world` (the frozen door
 * registry), never a fabricated list, so a staff visit to the signal cabin can only
 * ever open the signal cabin's own door. No RNG of its own, no wall clock, no React
 * (ADR-0007, ARCHITECTURE rule 8): the scheduler owns its rng and next tick.
 */
import { GAME_SECONDS_PER_TICK } from "../../game/tuning";
import type { Badge } from "../entities/badge";
import type { Presence } from "../world/presence";
import { type World, zoneTrustLevel } from "../world/world";
import type { WorldEnv, WorldReading } from "../world-reading";
import type { Actor } from "./actor";

/** One staff member's configuration: who it is, where it goes, and its pacing. */
export interface StaffConfig {
  /** The actor id, minted fresh per birth (never reused). Distinct from the badge. */
  id: string;
  /** The credential this staff carries: its id and its grade ceiling. */
  badge: Badge;
  /** The door-bearing location it visits: a site id or the control center id. */
  location: string;
  /** The station it walks in from and back out to. */
  nearestStation: string;
  /** The tick it first acts (begins walking in), phased by the spawner. */
  startTick: number;
  /** Walk-in and walk-out duration, in whole ticks (> 0). */
  walkTicks: number;
  /** Ticks between consecutive door taps, in whole ticks (> 0). */
  stepTicks: number;
}

/**
 * The presence a freshly admitted staff carries before its first act: standing `at`
 * its nearest station until it starts walking in. The engine builds it from the first
 * tick the schedule returns at admission.
 */
export function initialStaffPresence(nearestStation: string, firstTick: number): Presence {
  return { kind: "at", node: nearestStation, fromTick: firstTick, untilTick: firstTick };
}

/** The staff FSM phase: walking in, tapping the i-th eligible door, or walking out. */
type Phase = { kind: "arriving" } | { kind: "crossing"; index: number } | { kind: "leaving" };

/**
 * The location's doors this badge may open, in strictly ascending zone-trust order.
 * Read from the frozen `env.world.doors` registry: only doors at `location`, only
 * those whose zone trust is at or below the badge grade. The result is the benign
 * traversal, low to high, that the crossing walks without skipping.
 */
function eligibleDoors(
  world: World,
  location: string,
  grade: number,
): readonly { name: string; zone: string }[] {
  return world.doors
    .filter((door) => door.location === location && zoneTrustLevel(door.zone) <= grade)
    .map((door) => ({ name: door.name, zone: door.zone }))
    .sort((a, b) => zoneTrustLevel(a.zone) - zoneTrustLevel(b.zone));
}

/**
 * Build one transient staff member over its config. The returned actor holds its own
 * FSM state; the scheduler owns its next tick. It emits one `door-reader` grant per
 * eligible door in ascending zone order and reports a presence the view interpolates:
 * `moving` while walking between the station and the site, `at` the site while it works.
 */
export function createStaff(config: StaffConfig): Actor<WorldReading, WorldEnv> {
  let phase: Phase = { kind: "arriving" };

  // The eligible door list is a pure function of the frozen world, this staff's
  // location, and its badge grade, all stable across the run (ADR-0007 freezes env).
  // env only reaches `act`, so it is computed once on the first act and reused, rather
  // than re-derived (filter + sort over every world door) on every tick.
  let doorsMemo: readonly { name: string; zone: string }[] | undefined;

  /** One door-reader grant `WorldReading` at `tick`, in the game-second domain. */
  const grant = (door: { name: string; zone: string }, tick: number): WorldReading => ({
    sensor: "door-reader",
    reading: {
      ts: tick * GAME_SECONDS_PER_TICK,
      badge: config.badge.id,
      site: config.location,
      door: door.name,
      zone: door.zone,
      result: "grant",
    },
  });

  return {
    id: config.id,
    start: () => config.startTick,
    act: ({ env, tick }) => {
      if (doorsMemo === undefined) {
        doorsMemo = eligibleDoors(env.world, config.location, config.badge.grade);
      }
      const doors = doorsMemo;

      if (phase.kind === "arriving") {
        // Walk in from the nearest station to the site over `walkTicks`, no reading.
        phase = { kind: "crossing", index: 0 };
        return {
          readings: [],
          nextTick: tick + config.walkTicks,
          presence: {
            kind: "moving",
            from: config.nearestStation,
            to: config.location,
            line: "walk",
            fromTick: tick,
            untilTick: tick + config.walkTicks,
          },
        };
      }

      if (phase.kind === "crossing") {
        const door = doors[phase.index];
        if (door !== undefined) {
          // Tap the next eligible door: emit its grant, stay `at` the site.
          const nextTick = tick + config.stepTicks;
          phase = { kind: "crossing", index: phase.index + 1 };
          return {
            readings: [grant(door, tick)],
            nextTick,
            presence: { kind: "at", node: config.location, fromTick: tick, untilTick: nextTick },
          };
        }
        // Every eligible door is crossed: begin walking back out.
        phase = { kind: "leaving" };
        return {
          readings: [],
          nextTick: tick + config.walkTicks,
          presence: {
            kind: "moving",
            from: config.location,
            to: config.nearestStation,
            line: "walk",
            fromTick: tick,
            untilTick: tick + config.walkTicks,
          },
        };
      }

      // LEAVING: the walk-out has finished; the staff despawns.
      return { readings: [], nextTick: "dormant" };
    },
  };
}
