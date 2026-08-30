/**
 * The site network host: a PERSISTENT `Actor<WorldReading, WorldEnv>` at one staff site.
 * It relays a benign, small transfer to an internal destination at a fixed cadence —
 * bytes within the benign range, a destination from the shared `env.control` reference —
 * and emits one `network-relay` reading per transfer.
 *
 * It is a fixture in the `train.ts` pattern: seeded once via `createSchedule`'s initial
 * actors, present from the start through `initialTicks()`, and it never goes dormant, so
 * it is never evicted. Its presence is a fixed node: it sits `at` its site the whole run.
 * The scheduler owns its rng and next tick; the destination and byte draws are the only
 * rng it makes, so it replays for a seed. No wall clock, no React (ADR-0007,
 * ARCHITECTURE rule 8).
 */
import { GAME_SECONDS_PER_TICK } from "../../game/tuning";
import type { MapNodeId, Presence } from "../world/presence";
import type { WorldEnv, WorldReading } from "../world-reading";
import type { Actor } from "./actor";

/** One host's configuration: which site it is at, its host id, and its relay cadence. */
export interface HostConfig {
  /** The actor id, e.g. `"H1"`. Becomes the actor id (distinct from the host id). */
  id: string;
  /** The site id the host lives at (also its fixed presence node), e.g. `"dep"`. */
  site: string;
  /** The host id on the control backbone, e.g. `"YARD-NET-1"`. */
  host: string;
  /** The tick it sends its first relay, phased so hosts do not fire in lockstep. */
  startTick: number;
  /** Whole ticks between consecutive relays (> 0). */
  cadenceTicks: number;
}

/**
 * The presence a fixture host carries before its first relay: sitting `at` its site from
 * tick 0 until its first relay tick. The engine builds it from the first tick the
 * schedule reports for the fixture. A persistent fixture never leaves this node.
 */
export function initialHostPresence(site: MapNodeId, firstTick: number): Presence {
  return { kind: "at", node: site, fromTick: 0, untilTick: firstTick };
}

/**
 * Build one persistent host over its config. The returned actor holds no FSM state beyond
 * its config; the scheduler owns its next tick. Each transition draws a benign
 * destination and a byte count within the benign range from `env.control`, emits one
 * `network-relay` `WorldReading`, stays `at` its site, and reschedules one cadence later.
 */
export function createHost(config: HostConfig): Actor<WorldReading, WorldEnv> {
  return {
    id: config.id,
    start: () => config.startTick,
    act: ({ env, rng, tick }) => {
      const control = env.control;
      if (control === undefined || control.destinations.length === 0) {
        throw new Error(`host "${config.id}": env.control.destinations is required for a relay.`);
      }
      const dests = control.destinations;
      const dest = dests[Math.floor(rng() * dests.length)] ?? dests[0];
      if (dest === undefined) {
        throw new Error(`host "${config.id}": no destination to relay to.`);
      }
      const { min, max } = control.byteRange;
      // A whole-byte count in the inclusive benign range [min, max].
      const bytes = min + Math.floor(rng() * (max - min + 1));
      const nextTick = tick + config.cadenceTicks;
      const reading: WorldReading = {
        sensor: "network-relay",
        reading: {
          ts: tick * GAME_SECONDS_PER_TICK,
          site: config.site,
          host: config.host,
          dest,
          bytes,
        },
      };
      // A persistent fixture: it stays `at` its site, never moving, never dormant.
      const presence: Presence = {
        kind: "at",
        node: config.site,
        fromTick: tick,
        untilTick: nextTick,
      };
      return { readings: [reading], nextTick, presence };
    },
  };
}
