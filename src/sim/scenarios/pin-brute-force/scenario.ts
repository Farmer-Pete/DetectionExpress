/**
 * The pin-brute-force Scenario. Its shape is now a `ScenarioSpec` handed to the
 * shared `composeScenario` scaffold (GH42-PLAN.md "the scenario scaffold"), which
 * owns the fixed pipeline: build the casts, run the deterministic scheduler, and
 * compose the emitted readings into a `GeneratedRun`. This file supplies only what
 * makes the hunt itself distinct.
 *
 * The attacker cast plans `ATTACKS_PER_WAVE` PIN attackers per wave, each on a
 * globally distinct victim. The benign cast fills every admitted arrival slot with
 * one account rider, who may fumble a PIN (budgeted so a non-victim never crosses
 * the brute-force threshold). So only a victim's attacker burst is ever an Attack:
 * the stream stays separable, and any scoring error is a bug in the Rule, not the
 * data. Every draw comes from the seeded `rng` `composeScenario` builds, so the
 * same seed replays the run.
 *
 * The waves make the squeeze: benign Events per tick climb wave over wave against
 * the rule's fixed service rate, so a slow rule's Queue outgrows a checkpoint. The
 * attack fails and benign fumbles ride on top of that benign baseline.
 */
import type { ActorDescriptor, TimedReading } from "../../actors/actor";
import { admitArrivals } from "../../actors/admission";
import type { Attack } from "../../attack";
import {
  buildScenarioBlueprint,
  composeScenario,
  type ScenarioAttackerCast,
  type ScenarioBlueprint,
  type ScenarioCastContext,
  type ScenarioSpec,
} from "../../compose-scenario";
import { kioskV1, type RawKioskV1 } from "../../endpoints/kiosk/formats/kiosk-v1";
import type { GeneratedRun, Scenario, ScheduleMode } from "../../scenario";
import { assertThresholdInWindow } from "../../separability";
import { world } from "../../world/world";
import type { WorldEnv, WorldReading } from "../../world-reading";
import { type AttackPlan, attackFromPlan, planAttacks, selectVictims } from "./attacks";
import {
  assembleAttacker,
  assemblePatron,
  type BenignVisit,
  budgetFumbles,
  buildIdentityPools,
  buildPartitionedIdentityPools,
  type IdentityPools,
  pickSeeded,
} from "./cast";
import { ATTACKS_PER_WAVE, PIN_BRUTE_FORCE_THRESHOLD, PIN_BRUTE_FORCE_WINDOW_S } from "./tuning";

/** Accounts in the pool. The victims are a distinct subset; the rest stay benign. */
const ACCOUNT_COUNT = 40;

/** Ticks a benign patron lingers at the kiosk after signing in (emits nothing more). */
const BENIGN_DWELL_TICKS = 1;

/** The total attackers across all waves; the victim count `selectVictims` draws. */
const VICTIM_COUNT = ATTACKS_PER_WAVE.reduce((sum, n) => sum + n, 0);

/** A typed view of one kiosk reading, used by the separability assertions. */
interface FairRecord {
  account: string;
  ts: number;
  outcome: "success" | "fail";
  /** The owning Attack's id, or null for benign traffic (including a fumble). */
  attackId: number | null;
}

/** This scenario's attacker cast: the scaffold's minimal shape plus the identity pool the benign cast reuses. */
interface PinAttackerCast extends ScenarioAttackerCast<AttackPlan> {
  pools: IdentityPools;
}

/**
 * Plan every wave's bursts and describe one PIN attacker per burst. Draws the
 * identity pool first (partitioned when `ctx.partition` is set, else from the
 * run's own seeded rng), so its accounts and stations are available for the
 * benign cast, which the blueprint builds next.
 */
function attackerCast(ctx: ScenarioCastContext): PinAttackerCast {
  const pools =
    ctx.partition === undefined
      ? buildIdentityPools(ctx.rng, world, ACCOUNT_COUNT)
      : buildPartitionedIdentityPools(world, ACCOUNT_COUNT, ctx.partition);
  const victims = selectVictims(pools.accounts, ctx.rng, VICTIM_COUNT);
  const plans = planAttacks(ctx.waves, victims, ctx.rng);

  // Collect the actor-id -> attack-id label the scaffold reads back as ground truth.
  const labels = new Map<string, number>();
  const descriptors: ActorDescriptor<WorldReading, WorldEnv>[] = plans.map((plan) => {
    const { descriptor, label } = assembleAttacker({
      id: `attack-${plan.id}`,
      attackId: plan.id,
      account: plan.account,
      station: pickSeeded(pools.stations, ctx.rng),
      terminal: pickSeeded(pools.terminals, ctx.rng),
      failTimestamps: plan.failTimestamps,
    });
    labels.set(label[0], label[1]);
    return descriptor;
  });

  return { descriptors, labels, plans, pools };
}

/**
 * One benign patron per admitted arrival slot: draw its identity from the
 * attacker cast's own pool, then budget its fumbles (victims always 0, read off
 * the attacker's plans) so a non-victim can never cross the threshold.
 */
function benignCast(
  ctx: ScenarioCastContext,
  attacker: PinAttackerCast,
): ActorDescriptor<WorldReading, WorldEnv>[] {
  const victims = new Set(attacker.plans.map((plan) => plan.account));
  const slotTicks = admitArrivals(ctx.waves, ctx.scheduleMode);
  const visits = slotTicks.map((tick) => ({
    tick,
    account: pickSeeded(attacker.pools.accounts, ctx.rng),
    station: pickSeeded(attacker.pools.stations, ctx.rng),
    terminal: pickSeeded(attacker.pools.terminals, ctx.rng),
  }));
  const budgetInput: BenignVisit[] = visits.map((v) => ({ account: v.account, tick: v.tick }));
  const fumbleCounts = budgetFumbles(budgetInput, victims, ctx.rng);
  return visits.map((visit, i) =>
    assemblePatron({
      id: `patron-${i}`,
      account: visit.account,
      station: visit.station,
      terminal: visit.terminal,
      startTick: visit.tick,
      dwellTicks: BENIGN_DWELL_TICKS,
      fumbleFails: fumbleCounts[i] ?? 0,
    }),
  );
}

/** Narrow a timed reading to its kiosk record, or fail loudly: this hunt is kiosk-only. */
function kioskReading(t: TimedReading<WorldReading>) {
  if (t.reading.sensor !== "kiosk") {
    throw new Error(`kiosk run carried a ${t.reading.sensor} reading.`);
  }
  return t.reading.reading;
}

/** The endpoint's wire formatter, typed to `RawKioskV1` (narrower than `ScenarioSpec.format`'s `unknown`). */
function format(t: TimedReading<WorldReading>): RawKioskV1 {
  return kioskV1.format(kioskReading(t));
}

function endpointIdOf(): string {
  return kioskV1.id;
}

/**
 * A reading's owning Attack id: only a kiosk fail counts as evidence, so a future
 * multi-sensor attacker cannot silently contaminate it. A fumble's actor is not a
 * labeled attacker, so it maps to null.
 */
function attackIdOf(
  t: TimedReading<WorldReading>,
  labels: ReadonlyMap<string, number>,
): number | null {
  return kioskReading(t).outcome === "fail" ? (labels.get(t.actorId) ?? null) : null;
}

function toRecord(t: TimedReading<WorldReading>, labels: ReadonlyMap<string, number>): FairRecord {
  const { account, outcome, ts } = kioskReading(t);
  return { account, ts, outcome, attackId: attackIdOf(t, labels) };
}

/**
 * A defensive invariant: prove the data is separable before handing it out. A
 * violation here is a generation bug, so it fails loudly rather than reaching a
 * player as an unwinnable run. Two checks are this hunt's own; the third is the
 * shared `assertThresholdInWindow` (GH42-PLAN.md "the separability helper"), in
 * place of a hand-written window sweep.
 */
function assertSeparable(records: FairRecord[], attacks: Attack[]): void {
  const victims = new Set(attacks.map((a) => a.entity));
  for (const attack of attacks) {
    if (attack.eventIds.length < PIN_BRUTE_FORCE_THRESHOLD) {
      throw new Error(`Attack ${attack.id} carries too little evidence.`);
    }
  }
  for (const record of records) {
    if (record.outcome === "fail" && victims.has(record.account) && record.attackId === null) {
      throw new Error(`Victim ${record.account} emitted a benign failure outside its burst.`);
    }
  }

  const windowByAccount = new Map(attacks.map((a) => [a.entity, a.window]));
  assertThresholdInWindow({
    records,
    threshold: PIN_BRUTE_FORCE_THRESHOLD,
    window: PIN_BRUTE_FORCE_WINDOW_S,
    keyOf: (r) => r.account,
    tsOf: (r) => r.ts,
    qualifies: (r) => r.outcome === "fail",
    attackWindowOf: (key) => windowByAccount.get(key),
  });
}

/**
 * The one `ScenarioSpec`, shared by `generate` and `buildBlueprint` below, so both
 * read off the SAME cast builders — one seeded traversal, two ways to reach it
 * (GH117-PLAN.md "Part A"). Module-private: every caller, in and out of this
 * package, reaches it through `pinBruteForce.generate` or `buildBlueprint`, the
 * public seams, not by importing this object directly.
 */
const spec: ScenarioSpec<FairRecord, AttackPlan, PinAttackerCast> = {
  id: "pin-brute-force",
  attackerCast,
  benignCast,
  format,
  endpointIdOf,
  toRecord,
  attackIdOf,
  attackFromPlan,
  assertSeparable,
};

/**
 * Plan the whole run from a seed. Deterministic: the same seed (and, when given,
 * the same partition) always returns the same run. `pinBruteForce.generate` below
 * IS this function, so `partition` rides the public `Scenario.generate` contract
 * (GH42-PLAN.md "the merge seam"), not a scenario-specific side channel.
 *
 * Omitted, the account pool is drawn from this run's own seeded `rng`, exactly as
 * a solo run always has. Given an explicit partition, the account pool comes
 * instead from a fixed, seed-independent namespace slice
 * (`buildPartitionedIdentityPools`), so two runs generated from different seeds
 * but different partitions are guaranteed to draw disjoint accounts —
 * `mergeRuns`'s entity-disjointness invariant depends on this.
 */
function generate(seed: number, partition?: number): GeneratedRun {
  return composeScenario(spec, seed, partition);
}

/**
 * Build this scenario's immutable blueprint from a seed (GH117-PLAN.md "Part A").
 * Not part of the public `Scenario` interface: it is read by the test parity sweep,
 * and by the live app through `use-pipeline-controller.ts` -> `run-controller.ts`
 * (GH124-PLAN.md Checkpoint 3), not by `generate`'s callers.
 *
 * `mode` defaults to `"waves"`, the original climbing ramp, so every existing
 * caller is unaffected. The live app passes `"steady"` explicitly.
 */
export function buildBlueprint(
  seed: number,
  mode: ScheduleMode = "waves",
  partition?: number,
): ScenarioBlueprint<AttackPlan> {
  return buildScenarioBlueprint(spec, seed, mode, partition);
}

export const pinBruteForce: Scenario = {
  id: "pin-brute-force",
  generate,
};
