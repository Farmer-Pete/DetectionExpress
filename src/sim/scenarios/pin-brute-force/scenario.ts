/**
 * The pin-brute-force Scenario. It builds an actor cast over the shared kiosk
 * cast (`cast.ts`), runs the deterministic scheduler, and composes the emitted
 * readings into a `GeneratedRun`. One benign account rider fills each admitted
 * arrival slot; each wave carries `ATTACKS_PER_WAVE` PIN attackers on distinct
 * victims. Benign riders may fumble a PIN (budgeted so a non-victim never crosses
 * the brute-force threshold), so only a victim's attacker burst is ever an Attack:
 * the stream stays separable, and any scoring error is a bug in the Rule, not the
 * data. Every draw comes from the seeded `rng`, so the same seed replays the run.
 *
 * The waves make the squeeze: benign Events per tick climb wave over wave against
 * the rule's fixed service rate, so a slow rule's Queue outgrows a checkpoint. The
 * attack fails and benign fumbles ride on top of that benign baseline.
 */
import { randomLcg } from "d3-random";
import {
  ATTACKS_PER_WAVE,
  PIN_BRUTE_FORCE_THRESHOLD,
  PIN_BRUTE_FORCE_WINDOW_S,
} from "../../../game/tuning";
import type { Actor, TimedReading } from "../../actors/actor";
import { runActors } from "../../actors/actor";
import { admitArrivals } from "../../actors/admission";
import { composeRun } from "../../actors/compose";
import type { Attack } from "../../attack";
import { kioskV1 } from "../../endpoints/kiosk/formats/kiosk-v1";
import type { GeneratedRun, Scenario } from "../../scenario";
import { buildSchedule } from "../../schedule";
import { distanceTable } from "../../world/distance";
import { buildTimetable } from "../../world/timetable";
import { world } from "../../world/world";
import type { WorldEnv, WorldReading } from "../../world-reading";
import { attackFromPlan, planAttacks, selectVictims } from "./attacks";
import {
  assembleAttacker,
  assemblePatron,
  type BenignVisit,
  budgetFumbles,
  buildIdentityPools,
  buildPartitionedIdentityPools,
  pickSeeded,
} from "./cast";

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

/**
 * Plan the whole run from a seed. Deterministic: the same seed always returns the
 * same run.
 *
 * `partition` is the minimal composable-streams seam (GH42-PLAN.md "Composable
 * streams: the merge seam"): omitted (the `Scenario.generate` contract every
 * other caller uses), the account pool is drawn from this run's own seeded
 * `rng`, exactly as before. Given an explicit partition, the account pool comes
 * instead from a fixed, seed-independent namespace slice
 * (`buildPartitionedIdentityPools`), so two runs generated from different seeds
 * but different partitions are guaranteed to draw disjoint accounts —
 * `mergeRuns`'s entity-disjointness invariant depends on this. The full
 * `composeScenario` partition threading is a later milestone; this only proves
 * the seam.
 */
export function generate(seed: number, partition?: number): GeneratedRun {
  const rng = randomLcg(seed);
  const { waves, checkpoints } = buildSchedule();

  const pools =
    partition === undefined
      ? buildIdentityPools(rng, world, ACCOUNT_COUNT)
      : buildPartitionedIdentityPools(world, ACCOUNT_COUNT, partition);
  const victims = selectVictims(pools.accounts, rng, VICTIM_COUNT);
  const victimSet = new Set(victims);
  const plans = planAttacks(waves, victims, rng);

  // One benign patron per admitted arrival slot: draw its identity, then budget its
  // fumbles (victims always 0) so a non-victim can never cross the threshold.
  const slotTicks = admitArrivals(waves);
  const visits = slotTicks.map((tick) => ({
    tick,
    account: pickSeeded(pools.accounts, rng),
    station: pickSeeded(pools.stations, rng),
    terminal: pickSeeded(pools.terminals, rng),
  }));
  const budgetInput: BenignVisit[] = visits.map((v) => ({ account: v.account, tick: v.tick }));
  const fumbleCounts = budgetFumbles(budgetInput, victimSet, rng);
  const patrons: Actor<WorldReading, WorldEnv>[] = visits.map((visit, i) =>
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

  // One attacker per plan, at a drawn station and terminal. Collect the actor-id ->
  // attack-id label the composer reads back as ground truth.
  const labels = new Map<string, number>();
  const attackers: Actor<WorldReading, WorldEnv>[] = plans.map((plan) => {
    const { actor, label } = assembleAttacker({
      id: `attack-${plan.id}`,
      attackId: plan.id,
      account: plan.account,
      station: pickSeeded(pools.stations, rng),
      terminal: pickSeeded(pools.terminals, rng),
      failTimestamps: plan.failTimestamps,
    });
    labels.set(label[0], label[1]);
    return actor;
  });

  const env: WorldEnv = {
    world,
    distances: distanceTable(world),
    timetable: buildTimetable(world),
  };
  const scheduleEnd = checkpoints[checkpoints.length - 1]?.atTick ?? 0;
  // Every burst ends inside its wave, so the last reading precedes the final drain
  // gap; +2 covers the half-open horizon bound.
  const horizon = scheduleEnd + 2;

  const timed = runActors({ actors: [...patrons, ...attackers], env, runSeed: seed, horizon });

  const { events, eventIdsByAttack } = composeRun<TimedReading<WorldReading>>({
    readings: timed,
    tsOf: (t) => t.reading.reading.ts,
    format: (t) => {
      // Narrow the WorldReading union; kioskV1.format takes only the kiosk record.
      if (t.reading.sensor !== "kiosk") {
        throw new Error(`kiosk run composed a ${t.reading.sensor} reading.`);
      }
      return kioskV1.format(t.reading.reading);
    },
    endpointIdOf: () => kioskV1.id,
    // Guarded: only kiosk fail readings carry ground truth, so a future multi-sensor
    // attacker cannot silently contaminate it. A fumble's actor is not a labeled
    // attacker, so it maps to null.
    attackIdOf: (t) =>
      t.reading.sensor === "kiosk" && t.reading.reading.outcome === "fail"
        ? (labels.get(t.actorId) ?? null)
        : null,
  });

  const attacks = plans.map((plan) => attackFromPlan(plan, eventIdsByAttack.get(plan.id) ?? []));

  const records = toFairRecords(timed, labels);
  assertFair(records, victimSet, attacks);

  return { events, attacks, checkpoints, waves };
}

/**
 * Project the composed timed readings into typed fair records, reading each fail's
 * attack id back from the label map. The scenario emits only kiosk readings, so a
 * non-kiosk reading is a generation bug and fails loudly.
 */
function toFairRecords(
  timed: readonly TimedReading<WorldReading>[],
  labels: ReadonlyMap<string, number>,
): FairRecord[] {
  const records = timed.map((t): FairRecord => {
    if (t.reading.sensor !== "kiosk") {
      throw new Error(`kiosk run emitted a ${t.reading.sensor} reading.`);
    }
    const { account, outcome, ts } = t.reading.reading;
    const attackId = outcome === "fail" ? (labels.get(t.actorId) ?? null) : null;
    return { account, ts, outcome, attackId };
  });
  records.sort((a, b) => a.ts - b.ts);
  return records;
}

/**
 * A defensive invariant: prove the data is separable before handing it out. A
 * violation here is a generation bug, so it fails loudly rather than reaching a
 * player as an unwinnable run.
 */
function assertFair(records: FairRecord[], victims: Set<string>, attacks: Attack[]): void {
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
  assertNoStrayThreshold(records, attacks);
}

/**
 * The actual separability proof: no account's failures ever cross the threshold
 * inside any PIN_BRUTE_FORCE_WINDOW_S window, except as a victim's own Attack.
 * Records arrive sorted by `ts`, so each account's failures are already in time
 * order; a two-pointer sweep over each account's failures finds the worst window in
 * one pass. Benign fumbles are budgeted to at most four per non-victim window, below
 * the threshold of five, so a non-victim never trips this.
 */
function assertNoStrayThreshold(records: FairRecord[], attacks: Attack[]): void {
  const windowByAccount = new Map(attacks.map((a) => [a.entity, a.window]));
  const failsByAccount = new Map<string, FairRecord[]>();
  for (const record of records) {
    if (record.outcome !== "fail") {
      continue;
    }
    const list = failsByAccount.get(record.account) ?? [];
    list.push(record);
    failsByAccount.set(record.account, list);
  }

  for (const [account, fails] of failsByAccount) {
    const attackWindow = windowByAccount.get(account);
    let start = 0;
    for (let end = 0; end < fails.length; end++) {
      const endTs = fails[end]?.ts ?? 0;
      while (endTs - (fails[start]?.ts ?? 0) >= PIN_BRUTE_FORCE_WINDOW_S) {
        start++;
      }
      const inThisWindow = fails.slice(start, end + 1);
      if (inThisWindow.length < PIN_BRUTE_FORCE_THRESHOLD) {
        continue;
      }
      const insideAttack =
        attackWindow !== undefined &&
        inThisWindow.every(
          (f) => f.attackId !== null && f.ts >= attackWindow.startTs && f.ts <= attackWindow.endTs,
        );
      if (!insideAttack) {
        throw new Error(
          `Account ${account} crosses the PIN brute-force threshold within a ` +
            `${PIN_BRUTE_FORCE_WINDOW_S}s window outside any Attack.`,
        );
      }
    }
  }
}

/**
 * The briefing for the live scenario, shown above the Engine. It carries the new
 * voice: what the chaos is, and how the finished Engine answers it. It keeps the
 * real facts, five wrong PINs in five minutes and one Alert per burst, and it
 * describes the Engine at work rather than asking the player to write a Rule.
 */
const briefing =
  "PIN brute-force bursts hit the station kiosks. Each burst is one rider account " +
  "taking five or more wrong PINs inside five minutes, and the waves carry more of " +
  "them at once. Those bursts are the Attacks. Watch the Engine read the raw kiosk " +
  "PIN entries, normalize them, and count the failures per account. When a burst " +
  "crosses the line, it raises one Alert for the whole burst, not one per entry, and " +
  "the odd benign fumble never trips it. Normal traffic keeps rising in waves. Watch " +
  "the Compute gauge: the Engine holds its speed and stays ahead of the queue while " +
  "it catches every burst.";

export const pinBruteForce: Scenario = {
  id: "pin-brute-force",
  briefing,
  generate,
};
