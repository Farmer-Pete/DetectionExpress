/**
 * The world engine: the metro's live loop, a structural copy of the pipeline
 * `engine.ts` feeding a sibling store. It owns a Clock and a schedule built from the
 * startup fixtures, seeds each fixture's presence from `schedule.initialTicks()`,
 * and on every clock tick advances the sim by `SIM_TICKS_PER_CLOCK_TICK`, stepping
 * ONE tick at a time so a single step spans exactly one tick and every reading it
 * returns carries that tick.
 *
 * It folds each step into the authoritative `ActorView` map (presence deltas
 * overlaid, dormant actors pruned), derives flashes from that tick's finished
 * readings, and publishes an immutable `WorldSnapshot` every `CLOCK_HZ / PUBLISH_HZ`
 * clock ticks. It reads no wall clock (ARCHITECTURE rule 8). The fractional render
 * `nowTick` is NOT computed here; it is the integer `simTick` for now, and the
 * canvas owns the fractional estimate from M1.
 */
import { type Actor, createSchedule, type StepResult } from "../sim/actors/actor";
import type { RiderSpawner } from "../sim/actors/rider-spawner";
import type { StaffSpawner } from "../sim/actors/staff-spawner";
import { contactNodeId, gateNodeId, readerNodeId } from "../sim/world/layout";
import type { Presence } from "../sim/world/presence";
import type { TimedWorldReading, WorldEnv, WorldReading } from "../sim/world-reading";
import type { ActorView, FlashEvent, WorldSnapshot } from "../sim/world-snapshot";
import { Clock, intervalDriver, type TickDriver } from "./clock";
import { createDoorReducer } from "./door-reducer";
import {
  CLOCK_HZ,
  DOOR_DWELL_TICKS,
  FLASH_WINDOW_TICKS,
  GAME_SECONDS_PER_TICK,
  PUBLISH_HZ,
  SIM_TICKS_PER_CLOCK_TICK,
  WORLD_LOG_RETENTION,
} from "./tuning";
import { bindVisibility as bindVisibilityDefault } from "./visibility";

/**
 * A startup fixture: its actor, the `kind` the engine records for its view, and the
 * factory that seeds its presence once the schedule reports the fixture's first tick.
 */
export interface WorldFixture {
  actor: Actor<WorldReading, WorldEnv>;
  kind: ActorView["kind"];
  initialPresence: (firstTick: number) => Presence;
}

/** Everything the world engine reads from the outside. Injected so tests stay pure. */
export interface WorldStartOptions {
  fixtures: readonly WorldFixture[];
  env: WorldEnv;
  runSeed: number;
  setWorldSnapshot: (snapshot: WorldSnapshot) => void;
  /** Defaults to a real setInterval driver; tests pass a manual one. */
  driver?: TickDriver;
  /** Defaults to the real visibility binding; tests pass a no-op. */
  bindVisibility?: (clock: Clock) => () => void;
  /** Reports a loop failure (a throwing actor or sink). */
  onError?: (error: unknown) => void;
  /**
   * The seeded transient-rider source. When present the engine admits its births each
   * tick; when absent (M0 tests) it runs the fixtures alone. Deterministic per seed.
   */
  spawner?: RiderSpawner;
  /**
   * The seeded transient-staff source (M3). When present the engine admits its births
   * each tick, capped by the live staff count; when absent it runs without staff.
   */
  staffSpawner?: StaffSpawner;
  /**
   * The sim steps per clock tick, sampled each tick. A UI-only float (the pause/speed
   * control): 0 freezes the sim, 1 is real time, higher speeds it up. It never enters
   * the schedule; only the whole number of steps it accumulates to does. Defaults to
   * one step per clock tick.
   */
  getSpeed?: () => number;
}

/** A running world engine. `stop` tears it down; `whenStopped` settles for tests. */
export interface WorldEngineHandle {
  stop: () => void;
  whenStopped: Promise<void>;
}

/** Run one teardown step in isolation, so a throw cannot skip the others. */
function teardownStep(label: string, step: () => void): void {
  try {
    step();
  } catch (error) {
    console.error(`Detection Express: ${label} threw during teardown:`, error);
  }
}

/** Count the live actors by the snapshot's coarse kinds. */
function countKinds(views: Iterable<ActorView>): { riders: number; trains: number; staff: number } {
  let riders = 0;
  let trains = 0;
  let staff = 0;
  for (const view of views) {
    if (view.kind === "rider" || view.kind === "account-rider") {
      riders += 1;
    } else if (view.kind === "train") {
      trains += 1;
    } else if (view.kind === "staff") {
      staff += 1;
    }
  }
  return { riders, trains, staff };
}

export function startWorld(options: WorldStartOptions): WorldEngineHandle {
  if (CLOCK_HZ % PUBLISH_HZ !== 0) {
    throw new Error(
      `CLOCK_HZ (${CLOCK_HZ}) must be a whole multiple of PUBLISH_HZ (${PUBLISH_HZ}).`,
    );
  }
  if (!Number.isInteger(SIM_TICKS_PER_CLOCK_TICK) || SIM_TICKS_PER_CLOCK_TICK < 1) {
    throw new Error("SIM_TICKS_PER_CLOCK_TICK must be a positive integer.");
  }

  const schedule = createSchedule({
    actors: options.fixtures.map((fixture) => fixture.actor),
    env: options.env,
    runSeed: options.runSeed,
  });

  // The authoritative view map, seeded from each fixture's first tick. A fixture
  // that starts dormant has no numeric first tick, so it is omitted.
  const views = new Map<string, ActorView>();
  const initial = schedule.initialTicks();
  for (const fixture of options.fixtures) {
    const firstTick = initial.get(fixture.actor.id);
    if (firstTick === undefined) {
      continue;
    }
    views.set(fixture.actor.id, {
      id: fixture.actor.id,
      kind: fixture.kind,
      presence: fixture.initialPresence(firstTick),
    });
  }

  const flashes: FlashEvent[] = [];
  let nextFlashId = 0;
  let simTick = 0;
  // The door projection over the frozen env: a staff grant opens a door, and this
  // reducer closes it after a dwell (M3). It is not a scheduler actor (ADR-0007).
  const doorReducer = createDoorReducer(DOOR_DWELL_TICKS);
  // A bounded ring of the most recent normalized readings, for the event log. Newest
  // is pushed to the end; the snapshot publishes it newest-first.
  const recentLog: TimedWorldReading[] = [];
  // Fractional step accumulator: the speed multiplier accrues here and only whole
  // ticks are ever run, so the schedule sees integer ticks only.
  let stepAccumulator = 0;
  const speedOf = options.getSpeed ?? (() => 1);

  /** Seed an admitted or fixture actor's view with its initial presence. */
  const seedView = (id: string, kind: ActorView["kind"], presence: Presence): void => {
    views.set(id, { id, kind, presence });
  };

  /** The live rider count, the spawner's ceiling input. */
  const liveRiders = (): number =>
    [...views.values()].filter((view) => view.kind === "rider" || view.kind === "account-rider")
      .length;

  /** The live staff count, the staff spawner's ceiling input. */
  const liveStaff = (): number =>
    [...views.values()].filter((view) => view.kind === "staff").length;

  let clock: Clock | null = null;
  let detachVisibility: (() => void) | null = null;
  let stopped = false;

  let resolveTerminal: () => void = () => undefined;
  const whenStopped = new Promise<void>((resolve) => {
    resolveTerminal = resolve;
  });

  const stop = (): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    teardownStep("clock.stop", () => clock?.stop());
    teardownStep("visibility detach", () => detachVisibility?.());
    resolveTerminal();
  };

  const fail = (error: unknown): void => {
    if (stopped) {
      return;
    }
    stop();
    try {
      options.onError?.(error);
    } catch (handlerError) {
      console.error("Detection Express onError handler threw:", handlerError);
    }
  };

  // Fold one step into the world state: build that tick's fixed-order log, raise a
  // flash per fare-gate reading, overlay presence deltas, and evict dormant actors.
  const applyStep = (step: StepResult<WorldReading>): void => {
    const log: TimedWorldReading[] = step.readings.map((timed) => ({
      reading: timed.reading,
      tick: timed.tick,
      source: "actor",
      actorId: timed.actorId,
    }));
    for (const entry of log) {
      if (entry.reading.sensor === "fare-gate") {
        // The flash lands on the station's gate chip, not the station center, so the
        // view draws the ring right on the fare gate.
        flashes.push({
          id: nextFlashId,
          kind: "tap",
          node: gateNodeId(entry.reading.reading.station),
          atTick: entry.tick,
        });
        nextFlashId += 1;
      } else if (entry.reading.sensor === "train-tracker") {
        // A train arriving at or leaving a station flashes on the station node itself.
        flashes.push({
          id: nextFlashId,
          kind: "train",
          node: entry.reading.reading.station,
          atTick: entry.tick,
        });
        nextFlashId += 1;
      } else if (entry.reading.sensor === "door-reader") {
        // A staff grant flashes on the location's door-reader (R) chip.
        flashes.push({
          id: nextFlashId,
          kind: "grant",
          node: readerNodeId(entry.reading.reading.site),
          atTick: entry.tick,
        });
        nextFlashId += 1;
      }
      // Keep the reading for the event log; the retention trim runs after the door
      // reducer appends this tick's door-contact readings, so the fixed source order
      // (actor readings, then door) is preserved before the log is bounded.
      recentLog.push(entry);
    }
    for (const [id, presence] of step.presences) {
      const view = views.get(id);
      if (view !== undefined) {
        views.set(id, { id: view.id, kind: view.kind, presence });
      }
    }
    for (const id of step.dormant) {
      views.delete(id);
    }
  };

  // Run the door reducer for one tick over that tick's staff grants, AFTER the actor
  // readings are logged. It closes doors whose dwell has elapsed and opens the tick's
  // grants, then the engine turns each open/close into a `door-contact` reading (source
  // "door", appended after the actor readings) and a flash on the door-contact (D) chip.
  const reduceDoors = (step: StepResult<WorldReading>, tick: number): void => {
    const grants: { location: string; door: string }[] = [];
    for (const timed of step.readings) {
      if (timed.reading.sensor === "door-reader") {
        grants.push({ location: timed.reading.reading.site, door: timed.reading.reading.door });
      }
    }
    for (const event of doorReducer.step(grants, tick)) {
      const reading: WorldReading = {
        sensor: "door-contact",
        reading: {
          ts: tick * GAME_SECONDS_PER_TICK,
          site: event.location,
          door: event.door,
          event: event.event,
        },
      };
      recentLog.push({ reading, tick, source: "door" });
      flashes.push({
        id: nextFlashId,
        kind: "door",
        node: contactNodeId(event.location),
        atTick: tick,
      });
      nextFlashId += 1;
    }
    if (recentLog.length > WORLD_LOG_RETENTION) {
      recentLog.splice(0, recentLog.length - WORLD_LOG_RETENTION);
    }
  };

  // Drop flashes older than the window behind the current tick, so the list stays
  // bounded on a perpetual run. Flashes are appended in tick order.
  const pruneFlashes = (): void => {
    const cutoff = simTick - FLASH_WINDOW_TICKS;
    let drop = 0;
    while (drop < flashes.length && (flashes[drop]?.atTick ?? simTick) < cutoff) {
      drop += 1;
    }
    if (drop > 0) {
      flashes.splice(0, drop);
    }
  };

  const buildSnapshot = (): WorldSnapshot => {
    const actors = [...views.values()];
    // The door projection: each currently-open door lights its location's door-contact
    // (D) chip. Multiple open doors at one location collapse onto the one chip node.
    const openNodes = new Set(doorReducer.openDoors().map((door) => contactNodeId(door.location)));
    return {
      nowTick: simTick,
      actors,
      doors: [...openNodes].map((node) => ({ node, open: true })),
      crowds: [],
      flashes: [...flashes],
      // Newest first, so the log panel reads top to bottom as most-recent first.
      log: [...recentLog].reverse(),
      counts: countKinds(actors),
    };
  };

  // Admit each spawner's due births at the current frontier and seed each view. The
  // rider and staff spawners are independent, each capped by its own live count.
  const spawnTransients = (): void => {
    for (const admission of options.spawner?.tick(simTick, liveRiders()) ?? []) {
      const firstTick = schedule.admit(admission);
      seedView(admission.actor.id, admission.kind, admission.initialPresence(firstTick));
    }
    for (const admission of options.staffSpawner?.tick(simTick, liveStaff()) ?? []) {
      const firstTick = schedule.admit(admission);
      seedView(admission.actor.id, admission.kind, admission.initialPresence(firstTick));
    }
  };

  // The sampler publishes every `ticksPerSample` CLOCK ticks, so the publish rate
  // stays PUBLISH_HZ whatever `SIM_TICKS_PER_CLOCK_TICK` is.
  const ticksPerSample = CLOCK_HZ / PUBLISH_HZ;
  let lastPublishClock = 0;
  const maybePublish = (): void => {
    const now = clock?.now() ?? 0;
    if (now - lastPublishClock < ticksPerSample) {
      return;
    }
    lastPublishClock = now;
    options.setWorldSnapshot(buildSnapshot());
  };

  try {
    const driver = options.driver ?? intervalDriver(CLOCK_HZ);
    clock = new Clock(CLOCK_HZ, driver);

    const bind = options.bindVisibility ?? bindVisibilityDefault;
    detachVisibility = bind(clock);

    clock.onTick(() => {
      if (stopped) {
        return;
      }
      try {
        // Accrue the speed multiplier and run only the whole ticks it accumulates to,
        // so the schedule advances one integer tick at a time and never sees a
        // fractional step. Speed 0 (paused) accrues nothing and freezes the sim.
        stepAccumulator += SIM_TICKS_PER_CLOCK_TICK * Math.max(0, speedOf());
        const steps = Math.floor(stepAccumulator);
        stepAccumulator -= steps;
        for (let i = 0; i < steps; i++) {
          const step = schedule.advanceTo(simTick + 1);
          applyStep(step);
          // The door reducer runs each tick over this step's grants (the tick being
          // processed is `simTick`, before the increment), so a door closes on time
          // even on a tick with no grants.
          reduceDoors(step, simTick);
          simTick += 1;
          spawnTransients();
        }
        pruneFlashes();
        maybePublish();
      } catch (error) {
        fail(error);
      }
    });

    return { stop, whenStopped };
  } catch (error) {
    stop(); // partial teardown, so a half-built engine leaks nothing
    throw error;
  }
}
