/**
 * The OCC operator: a PERSISTENT `Actor<WorldReading, WorldEnv>` seated at one control
 * console in the Operations Control Center. It issues a benign control-room command at a
 * fixed cadence — an authorized operator on an authorized console, drawing a benign
 * command/target pair from the shared `env.control` reference — and emits one
 * `occ-console` reading per command.
 *
 * It is a fixture in the `train.ts` pattern: seeded once via `createSchedule`'s initial
 * actors, present from the start through `initialTicks()`, and it never goes dormant, so
 * it is never evicted. Its presence is a fixed node: it sits `at` the OCC the whole run.
 * The scheduler owns its rng and next tick; the command draw is the only rng it makes, so
 * it replays for a seed. No wall clock, no React (ADR-0007, ARCHITECTURE rule 8).
 */
import { GAME_SECONDS_PER_TICK } from "../../game/tuning";
import type { Console } from "../entities/control";
import type { MapNodeId, Presence } from "../world/presence";
import type { WorldEnv, WorldReading } from "../world-reading";
import type { Actor } from "./actor";

/** One operator's configuration: who it is, where it sits, and its command cadence. */
export interface OperatorConfig {
  /** The actor id, e.g. `"OP1"`. Becomes the actor id (distinct from the login). */
  id: string;
  /** The OCC map node the operator sits `at` (the control center id). */
  node: MapNodeId;
  /** The authorized console it is seated at: its operator login and its host. */
  console: Console;
  /** The tick it issues its first command, phased so operators do not fire in lockstep. */
  startTick: number;
  /** Whole ticks between consecutive commands (> 0). */
  cadenceTicks: number;
}

/**
 * The presence a fixture operator carries before its first command: seated `at` the OCC
 * from tick 0 until its first command tick. The engine builds it from the first tick the
 * schedule reports for the fixture. A persistent fixture never leaves this node.
 */
export function initialOperatorPresence(node: MapNodeId, firstTick: number): Presence {
  return { kind: "at", node, fromTick: 0, untilTick: firstTick };
}

/**
 * Build one persistent operator over its config. The returned actor holds no FSM state
 * beyond its config; the scheduler owns its next tick. Each transition draws a benign
 * command/target from `env.control.commands`, emits one `occ-console` `WorldReading` from
 * its authorized console, stays seated `at` the OCC, and reschedules one cadence later.
 */
export function createOperator(config: OperatorConfig): Actor<WorldReading, WorldEnv> {
  return {
    id: config.id,
    start: () => config.startTick,
    act: ({ env, rng, tick }) => {
      const control = env.control;
      if (control === undefined || control.commands.length === 0) {
        throw new Error(`operator "${config.id}": env.control.commands is required for a command.`);
      }
      const commands = control.commands;
      const pick = commands[Math.floor(rng() * commands.length)] ?? commands[0];
      if (pick === undefined) {
        throw new Error(`operator "${config.id}": no command to issue.`);
      }
      const nextTick = tick + config.cadenceTicks;
      const reading: WorldReading = {
        sensor: "occ-console",
        reading: {
          ts: tick * GAME_SECONDS_PER_TICK,
          operator: config.console.operator,
          host: config.console.host,
          command: pick.command,
          target: pick.target,
        },
      };
      // A persistent fixture: it stays `at` the OCC, never moving, never dormant.
      const presence: Presence = {
        kind: "at",
        node: config.node,
        fromTick: tick,
        untilTick: nextTick,
      };
      return { readings: [reading], nextTick, presence };
    },
  };
}
