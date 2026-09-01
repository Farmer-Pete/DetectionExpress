/**
 * The metro's ambient cast, assembled once and shared by both the legacy world run
 * controller and the merged pipeline run controller (GH117-PLAN.md "Part B"). It owns
 * the two things every ambient run needs: the persistent startup fixtures (one train
 * per line, one operator per OCC console, one host per site) and the three seeded
 * runtime spawners (riders, staff, account riders). Extracted so the two controllers
 * build the identical cast rather than duplicating the builders; a later step collapses
 * the two controllers into one.
 *
 * It is pure over its inputs: given the same world, timetable, and seed it returns an
 * equivalent cast. It reads no wall clock and no React (ARCHITECTURE rule 8, ADR-0007).
 */

import {
  type AccountRiderSpawner,
  createAccountRiderSpawner,
} from "../sim/actors/account-rider-spawner";
import { createHost, initialHostPresence } from "../sim/actors/host";
import { createOperator, initialOperatorPresence } from "../sim/actors/operator";
import { createRiderSpawner, type RiderSpawner } from "../sim/actors/rider-spawner";
import { createStaffSpawner, type StaffSpawner } from "../sim/actors/staff-spawner";
import { createTrain, initialTrainPresence } from "../sim/actors/train";
import { controlReference } from "../sim/entities/control";
import { type Timetable, trainIdForLine } from "../sim/world/timetable";
import type { World } from "../sim/world/world";
import type { AmbientFixture } from "./engine";
import {
  ACCOUNT_RIDER_TARGET,
  CONTROL_LAUNCH_PHASE_TICKS,
  HOST_RELAY_TICKS,
  OPERATOR_COMMAND_TICKS,
  STAFF_TARGET,
  TARGET_RIDERS,
} from "./tuning";

/** The three seeded runtime spawners an ambient run admits each tick. */
export interface AmbientSpawners {
  spawner: RiderSpawner;
  staffSpawner: StaffSpawner;
  accountSpawner: AccountRiderSpawner;
}

/**
 * The persistent ambient fixtures: one train per line (fresh per run so a re-run starts
 * each train at its origin), one operator per authorized OCC console (staggered launch
 * phases so they never issue commands in lockstep), and one host per site network host.
 */
export function buildAmbientFixtures(world: World, timetable: Timetable): AmbientFixture[] {
  const occId = world.controlCenter.id;

  const trains: AmbientFixture[] = world.lines.map((line) => {
    const schedule = timetable.line(line.id);
    const origin = schedule.stops[0] ?? line.id;
    // The same deterministic line -> train id the live rider names when it boards, so a
    // rider's onTrain presence references this exact train fixture.
    const id = trainIdForLine(world, line.id);
    return {
      actor: createTrain({ id, line: line.id, startTick: schedule.startTick }),
      kind: "train",
      initialPresence: (firstTick) => initialTrainPresence(origin, firstTick, line.id),
    };
  });

  const operators: AmbientFixture[] = controlReference.consoles.map((consoleRef, index) => {
    const id = `OP${index + 1}`;
    return {
      actor: createOperator({
        id,
        node: occId,
        console: consoleRef,
        startTick: index * CONTROL_LAUNCH_PHASE_TICKS,
        cadenceTicks: OPERATOR_COMMAND_TICKS,
      }),
      kind: "operator",
      initialPresence: (firstTick) => initialOperatorPresence(occId, firstTick),
    };
  });

  const hosts: AmbientFixture[] = controlReference.hosts.map((siteHost, index) => {
    const id = `H${index + 1}`;
    return {
      actor: createHost({
        id,
        site: siteHost.site,
        host: siteHost.host,
        startTick: index * CONTROL_LAUNCH_PHASE_TICKS,
        cadenceTicks: HOST_RELAY_TICKS,
      }),
      kind: "host",
      initialPresence: (firstTick) => initialHostPresence(siteHost.site, firstTick),
    };
  });

  return [...trains, ...operators, ...hosts];
}

/** Fresh, seeded rider / staff / account-rider spawners for one run of the given seed. */
export function buildAmbientSpawners(world: World, seed: number): AmbientSpawners {
  return {
    spawner: createRiderSpawner({ seed, world, target: TARGET_RIDERS }),
    staffSpawner: createStaffSpawner({ seed, world, target: STAFF_TARGET }),
    accountSpawner: createAccountRiderSpawner({ seed, world, target: ACCOUNT_RIDER_TARGET }),
  };
}
