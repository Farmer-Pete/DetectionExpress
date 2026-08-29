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
import type { Presence } from "../sim/world/presence";
import type { TimedWorldReading, WorldEnv, WorldReading } from "../sim/world-reading";
import type { ActorView, FlashEvent, WorldSnapshot } from "../sim/world-snapshot";
import { Clock, intervalDriver, type TickDriver } from "./clock";
import { CLOCK_HZ, FLASH_WINDOW_TICKS, PUBLISH_HZ, SIM_TICKS_PER_CLOCK_TICK } from "./tuning";
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
        flashes.push({
          id: nextFlashId,
          kind: "tap",
          node: entry.reading.reading.station,
          atTick: entry.tick,
        });
        nextFlashId += 1;
      }
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
    return {
      nowTick: simTick,
      actors,
      doors: [],
      crowds: [],
      flashes: [...flashes],
      counts: countKinds(actors),
    };
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
        for (let i = 0; i < SIM_TICKS_PER_CLOCK_TICK; i++) {
          const step = schedule.advanceTo(simTick + 1);
          applyStep(step);
          simTick += 1;
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
