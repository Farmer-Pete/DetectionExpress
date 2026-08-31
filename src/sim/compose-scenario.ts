/**
 * The scenario scaffold (GH42-PLAN.md "The scenario scaffold"). `composeScenario`
 * owns the fixed pipeline every world-modeled Scenario shares: build an attacker
 * cast and a benign cast over one seeded schedule, run the shared metro world to a
 * fixed horizon, compose the sorted stream, turn the attacker's plans into Attack
 * ground truth, and prove separability before handing the run out. A Scenario
 * supplies only what makes it distinct, through a `ScenarioSpec`: its casts, its
 * wire format, its projection into a typed record, and its own separability proof.
 * It sits above `actors/compose.ts`, which it calls into, not below it.
 *
 * `composeScenario` builds the attacker cast BEFORE the benign cast and hands the
 * benign cast that output, because a benign cast that budgets a fumble needs to
 * know which accounts are already victims, so it never fumbles one into a false
 * Attack. `ScenarioAttackerCast` carries whatever else a scenario's benign cast
 * needs (pin-brute-force adds the identity pool it drew from), typed all the way
 * through with no unsafe cast.
 *
 * `partition` threads the composable-streams seam (GH42-PLAN.md "the merge seam")
 * into the cast context: a scenario's casts read it to draw from a partitioned,
 * seed-independent identity namespace instead of the run's own seeded rng, so two
 * runs generated for different partitions draw disjoint entities.
 */
import { randomLcg } from "d3-random";
import type { Actor, TimedReading } from "./actors/actor";
import { runActors } from "./actors/actor";
import { composeRun } from "./actors/compose";
import type { Attack } from "./attack";
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
 * The attacker cast's minimal output: its actors, the ground-truth actor-id ->
 * attack-id labels, and its plans. `Plan` must carry an `id`, so `composeScenario`
 * can look each plan's Event ids up after the stream is composed. A scenario may
 * widen this (its concrete `attackerCast` return type) with extra fields its own
 * `benignCast` needs; `composeScenario` is generic over that concrete shape.
 */
export interface ScenarioAttackerCast<Plan extends { id: number }> {
  actors: Actor<WorldReading, WorldEnv>[];
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
  benignCast(ctx: ScenarioCastContext, attacker: Attacker): Actor<WorldReading, WorldEnv>[];
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

/** Every `WorldReading` arm carries its own `ts`; this reads it once, generically. */
function tsOf(t: TimedReading<WorldReading>): number {
  return t.reading.reading.ts;
}

/**
 * Plan the whole run from a seed. Deterministic: the same seed always returns the
 * same run.
 */
export function composeScenario<
  Rec,
  Plan extends { id: number },
  Attacker extends ScenarioAttackerCast<Plan>,
>(spec: ScenarioSpec<Rec, Plan, Attacker>, seed: number, partition?: number): GeneratedRun {
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
  const benignActors = spec.benignCast(ctx, attacker);

  const env: WorldEnv = {
    world,
    distances: distanceTable(world),
    timetable: buildTimetable(world),
  };
  const scheduleEnd = checkpoints[checkpoints.length - 1]?.atTick ?? 0;
  // Every burst ends inside its wave, so the last reading precedes the final drain
  // gap; +2 covers the half-open horizon bound.
  const horizon = scheduleEnd + 2;

  const timed = runActors({
    actors: [...benignActors, ...attacker.actors],
    env,
    runSeed: seed,
    horizon,
  });

  const { events, eventIdsByAttack } = composeRun<TimedReading<WorldReading>>({
    readings: timed,
    tsOf,
    format: spec.format,
    endpointIdOf: spec.endpointIdOf,
    attackIdOf: (t) => spec.attackIdOf(t, attacker.labels),
  });

  const attacks: Attack[] = attacker.plans.map((plan) =>
    spec.attackFromPlan(plan, eventIdsByAttack.get(plan.id) ?? []),
  );

  const records = timed.map((t) => spec.toRecord(t, attacker.labels));
  spec.assertSeparable(records, attacks);

  return { events, attacks, checkpoints, waves };
}
