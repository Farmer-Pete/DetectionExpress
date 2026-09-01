/**
 * The scenario scaffold (GH42-PLAN.md "The scenario scaffold"), extended by
 * GH117-PLAN.md "Part A" with the immutable blueprint seam. `buildScenarioBlueprint`
 * owns the fixed pipeline every world-modeled Scenario shares: build an attacker
 * cast and a benign cast over ONE seeded schedule, capture them as immutable actor
 * descriptors (not built actors — actors are mutable closures), instantiate a fresh
 * cast and run it to a fixed horizon, compose the sorted stream, turn the
 * attacker's plans into Attack ground truth, and prove separability before handing
 * the blueprint out. A Scenario supplies only what makes it distinct, through a
 * `ScenarioSpec`: its casts, its wire format, its projection into a typed record,
 * and its own separability proof. It sits above `actors/compose.ts`, which it calls
 * into, not below it.
 *
 * `composeScenario` is the legacy batch entry point: a thin wrapper that builds a
 * blueprint and returns its precomposed run. It is what it always was, byte for
 * byte — the blueprint is the same one seeded traversal, exposed rather than
 * discarded, so today's callers see no change.
 *
 * `buildScenarioBlueprint` builds the attacker cast BEFORE the benign cast and
 * hands the benign cast that output, because a benign cast that budgets a fumble
 * needs to know which accounts are already victims, so it never fumbles one into a
 * false Attack. `ScenarioAttackerCast` carries whatever else a scenario's benign
 * cast needs (pin-brute-force adds the identity pool it drew from), typed all the
 * way through with no unsafe cast.
 *
 * `partition` threads the composable-streams seam (GH42-PLAN.md "the merge seam")
 * into the cast context: a scenario's casts read it to draw from a partitioned,
 * seed-independent identity namespace instead of the run's own seeded rng, so two
 * runs generated for different partitions draw disjoint entities.
 */
import { randomLcg } from "d3-random";
import type { Actor, ActorDescriptor, TimedReading } from "./actors/actor";
import { instantiateActors, runActors } from "./actors/actor";
import { composeEvent, composeRun } from "./actors/compose";
import type { Attack } from "./attack";
import type { PipeEvent } from "./event";
import type { Checkpoint, GeneratedRun, Wave } from "./scenario";
import { buildSchedule } from "./schedule";
import { distanceTable } from "./world/distance";
import { buildTimetable } from "./world/timetable";
import { world } from "./world/world";
import type { WorldEnv, WorldReading } from "./world-reading";

/** The seeded context every cast builder reads: the run's rng and its shared wave schedule. */
export interface ScenarioCastContext {
  rng: () => number;
  waves: readonly Wave[];
  checkpoints: readonly Checkpoint[];
  /** The composable-streams partition (GH42-PLAN.md), set only when this run is one of several merged runs. */
  partition?: number;
}

/**
 * The attacker cast's minimal output: its actor descriptors (not built actors —
 * see `ActorDescriptor`), the ground-truth actor-id -> attack-id labels, and its
 * plans. `Plan` must carry an `id`, so the blueprint can look each plan's Event ids
 * up after the stream is composed. A scenario may widen this (its concrete
 * `attackerCast` return type) with extra fields its own `benignCast` needs;
 * `buildScenarioBlueprint` is generic over that concrete shape.
 */
export interface ScenarioAttackerCast<Plan extends { id: number }> {
  descriptors: ActorDescriptor<WorldReading, WorldEnv>[];
  labels: Map<string, number>;
  plans: Plan[];
}

/**
 * What makes one world-modeled Scenario distinct. `Rec` is the scenario's own
 * typed projection of a timed reading, read only by its `assertSeparable`. `Plan`
 * is its attack-plan shape. `Attacker` is the attacker cast's concrete return
 * shape, at minimum `ScenarioAttackerCast<Plan>`.
 */
export interface ScenarioSpec<
  Rec,
  Plan extends { id: number },
  Attacker extends ScenarioAttackerCast<Plan>,
> {
  readonly id: string;
  attackerCast(ctx: ScenarioCastContext): Attacker;
  /** Reads the already-built attacker cast, e.g. to avoid fumbling a victim. */
  benignCast(
    ctx: ScenarioCastContext,
    attacker: Attacker,
  ): ActorDescriptor<WorldReading, WorldEnv>[];
  /** The endpoint's wire formatter, over one timed reading. */
  format(timed: TimedReading<WorldReading>): unknown;
  /** This reading's endpoint id. */
  endpointIdOf(timed: TimedReading<WorldReading>): string;
  /** Project one timed reading into the typed record the separability proof reads. */
  toRecord(timed: TimedReading<WorldReading>, labels: ReadonlyMap<string, number>): Rec;
  /** The reading's owning Attack id, or null for benign traffic. Reads the labels `attackerCast` built. */
  attackIdOf(timed: TimedReading<WorldReading>, labels: ReadonlyMap<string, number>): number | null;
  /** The Attack ground truth for one plan, once its failures have their Event ids. */
  attackFromPlan(plan: Plan, eventIds: number[]): Attack;
  /** The separability proof: throws on any violation, before the run is handed out. */
  assertSeparable(records: Rec[], attacks: Attack[]): void;
}

/**
 * The immutable scenario blueprint (GH117-PLAN.md "Part A"): everything ONE seeded
 * traversal learns, held as data rather than as built actors. `descriptors` and
 * `labels` are what a live consumer (not built in this step) would read to run its
 * own schedule; `precomposed` is the same `{ events, attacks }` `composeScenario`
 * has always returned, used only as the scorer's Attack manifest and as the test
 * parity oracle — it is never fed to a live engine from here. `instantiate()`
 * builds a FRESH actor cast from `descriptors` on every call, since actors are
 * mutable closures and the blueprint itself must stay a pure, reusable value.
 */
export interface ScenarioBlueprint<Plan extends { id: number }> {
  readonly descriptors: readonly ActorDescriptor<WorldReading, WorldEnv>[];
  readonly labels: ReadonlyMap<string, number>;
  readonly plans: readonly Plan[];
  /**
   * The read-only environment the cast reads on each transition (GH117-PLAN.md
   * "Part B"). The blueprint composed its precomposed run over exactly this env, so a
   * live consumer steps the instantiated cast over the same one rather than rebuilding
   * it and risking a drift from the batch path.
   */
  readonly env: WorldEnv;
  /** The endpoint's wire formatter, over one timed reading. */
  readonly format: (timed: TimedReading<WorldReading>) => unknown;
  /** This reading's endpoint id. */
  readonly endpointIdOf: (timed: TimedReading<WorldReading>) => string;
  /**
   * Mint one wire event for a scored reading at a chosen id (GH117-PLAN.md "Part C").
   * The live engine calls this per scored-scenario kiosk reading, assigning the next
   * dense id in emission order, so a live-emitted event is byte-identical to the
   * precomposed one the scorer's Attack evidence binds to. Parity guard 1 proves it.
   */
  readonly toEvent: (timed: TimedReading<WorldReading>, id: number) => PipeEvent;
  /**
   * The last tick on which the scenario cast emits a scored reading (GH117-PLAN.md
   * "Part C", "Scored horizon"). When the live tick loop passes it, the engine closes
   * the scored ingress, so the pipeline drains and finalizes exactly once.
   */
  readonly lastScoredTick: number;
  readonly waves: readonly Wave[];
  readonly checkpoints: readonly Checkpoint[];
  /** The scorer's Attack manifest and the test parity oracle. Not a live source. */
  readonly precomposed: {
    readonly events: readonly PipeEvent[];
    readonly attacks: readonly Attack[];
  };
  /** Build a fresh actor cast from `descriptors`. Independent state on every call. */
  instantiate(): Actor<WorldReading, WorldEnv>[];
}

/** Every `WorldReading` arm carries its own `ts`; this reads it once, generically. */
function tsOf(t: TimedReading<WorldReading>): number {
  return t.reading.reading.ts;
}

/**
 * Build the immutable blueprint from a seed: ONE seeded traversal (`attackerCast`
 * then `benignCast`, reading the same `ctx.rng`), captured as descriptors rather
 * than built actors. It then calls `instantiate()` itself, once, to run that same
 * seeded cast to the scenario's horizon and precompose the scored run — the
 * scorer's Attack manifest and the test parity oracle — before handing the
 * blueprint out. Deterministic: the same seed (and partition) always returns an
 * equivalent blueprint.
 */
export function buildScenarioBlueprint<
  Rec,
  Plan extends { id: number },
  Attacker extends ScenarioAttackerCast<Plan>,
>(
  spec: ScenarioSpec<Rec, Plan, Attacker>,
  seed: number,
  partition?: number,
): ScenarioBlueprint<Plan> {
  const rng = randomLcg(seed);
  const { waves, checkpoints } = buildSchedule();
  // Built with a spread, not a `partition: undefined` literal: `exactOptionalPropertyTypes`
  // distinguishes an omitted key from one explicitly set to `undefined`.
  const ctx: ScenarioCastContext = {
    rng,
    waves,
    checkpoints,
    ...(partition === undefined ? {} : { partition }),
  };

  const attacker = spec.attackerCast(ctx);
  const benignDescriptors = spec.benignCast(ctx, attacker);
  const descriptors = [...benignDescriptors, ...attacker.descriptors];

  const env: WorldEnv = {
    world,
    distances: distanceTable(world),
    timetable: buildTimetable(world),
  };
  const scheduleEnd = checkpoints[checkpoints.length - 1]?.atTick ?? 0;
  // Every burst ends inside its wave, so the last reading precedes the final drain
  // gap; +2 covers the half-open horizon bound.
  const horizon = scheduleEnd + 2;

  const instantiate = (): Actor<WorldReading, WorldEnv>[] => instantiateActors(descriptors);

  const timed = runActors({ actors: instantiate(), env, runSeed: seed, horizon });

  const { events, eventIdsByAttack } = composeRun<TimedReading<WorldReading>>({
    readings: timed,
    tsOf,
    format: spec.format,
    endpointIdOf: spec.endpointIdOf,
    attackIdOf: (t) => spec.attackIdOf(t, attacker.labels),
  });

  const attacks: Attack[] = attacker.plans.map((plan) => {
    const eventIds = eventIdsByAttack.get(plan.id);
    if (eventIds === undefined) {
      throw new Error(
        `buildScenarioBlueprint: "${spec.id}" plan ${plan.id} composed no Events, so its Attack ` +
          "would carry no evidence and could never be credited.",
      );
    }
    return spec.attackFromPlan(plan, eventIds);
  });

  const records = timed.map((t) => spec.toRecord(t, attacker.labels));
  spec.assertSeparable(records, attacks);

  // The live scored-ingress adapter (GH117-PLAN.md "Part C"): mint one event per
  // scored reading through the SAME construction the precompose used, so a live event
  // equals its precomposed twin byte for byte. The engine supplies the id in emission
  // order.
  const toEvent = (t: TimedReading<WorldReading>, id: number): PipeEvent =>
    composeEvent(t, id, { tsOf, format: spec.format, endpointIdOf: spec.endpointIdOf });
  // The last tick the scenario cast emits on, read straight off the composed run: the
  // horizon after which the live engine closes the ingress. Every reading here is a
  // scored scenario reading (the batch precompose steps only the scenario cast), so the
  // maximum emission tick is the last scored tick. Empty run: nothing to close past 0.
  const lastScoredTick = timed.reduce((max, t) => Math.max(max, t.tick), 0);

  return {
    descriptors,
    labels: attacker.labels,
    plans: attacker.plans,
    env,
    format: spec.format,
    endpointIdOf: spec.endpointIdOf,
    toEvent,
    lastScoredTick,
    waves,
    checkpoints,
    precomposed: { events, attacks },
    instantiate,
  };
}

/**
 * Plan the whole run from a seed. Deterministic: the same seed always returns the
 * same run. A thin wrapper over `buildScenarioBlueprint`: the precomposed run IS
 * the blueprint's own, so this stays byte for byte what it always returned.
 */
export function composeScenario<
  Rec,
  Plan extends { id: number },
  Attacker extends ScenarioAttackerCast<Plan>,
>(spec: ScenarioSpec<Rec, Plan, Attacker>, seed: number, partition?: number): GeneratedRun {
  const blueprint = buildScenarioBlueprint(spec, seed, partition);
  return {
    events: [...blueprint.precomposed.events],
    attacks: [...blueprint.precomposed.attacks],
    checkpoints: [...blueprint.checkpoints],
    waves: [...blueprint.waves],
  };
}
