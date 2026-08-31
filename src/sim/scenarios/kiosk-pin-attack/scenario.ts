/**
 * The kiosk-pin-attack Scenario. It composes the kiosk endpoint, plans one Attack
 * per wave, then fills each wave with rising benign volume. Benign traffic is all
 * successes, so only victims ever fail and the stream is always separable: any
 * scoring error is a bug in the Rule, not the data. Every draw comes from the
 * seeded `rng` and `faker`, so the same seed always replays the same run.
 *
 * The waves make the squeeze: benign Events per tick climb wave over wave against
 * the rule's fixed service rate, so a slow rule's Queue outgrows a checkpoint.
 */
import { en, Faker } from "@faker-js/faker";
import { randomLcg } from "d3-random";
import {
  GAME_SECONDS_PER_TICK,
  PIN_BRUTE_FORCE_THRESHOLD,
  PIN_BRUTE_FORCE_WINDOW_S,
} from "../../../game/tuning";
import type { Attack } from "../../attack";
import { kioskV1, type RawKioskV1 } from "../../endpoints/kiosk/formats/kiosk-v1";
import { generateKiosk } from "../../endpoints/kiosk/internal";
import type { GeneratedRun, Scenario } from "../../scenario";
import { buildSchedule } from "../../schedule";
import { attackFromPlan, planAttacks } from "./attacks";

/** Accounts in the pool. One distinct victim per wave; the rest stay benign. */
const ACCOUNT_COUNT = 40;

/** A planned Event before it is sorted and assigned its engine id. */
interface Draft {
  ts: number;
  account: string;
  outcome: "success" | "fail";
  /** The owning Attack's id, or null for benign traffic. */
  attackId: number | null;
  payload: RawKioskV1;
  /** Creation order, the stable tiebreak when two Events share a time. */
  seq: number;
}

/** Build a stable pool of distinct account names from the seeded faker. */
function buildAccounts(faker: Faker): string[] {
  const accounts = new Set<string>();
  while (accounts.size < ACCOUNT_COUNT) {
    accounts.add(faker.internet.username());
  }
  return [...accounts];
}

/** Pick `count` distinct victims by shuffling the pool with the seeded rng. */
function selectVictims(accounts: string[], rng: () => number, count: number): string[] {
  const order = [...accounts];
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(rng() * (order.length - i));
    const here = order[i];
    const there = order[j];
    if (here !== undefined && there !== undefined) {
      order[i] = there;
      order[j] = here;
    }
  }
  return order.slice(0, count);
}

function generate(seed: number): GeneratedRun {
  const faker = new Faker({ locale: en });
  faker.seed(seed);
  const rng = randomLcg(seed);

  const { waves, checkpoints } = buildSchedule();
  const accounts = buildAccounts(faker);
  const victims = selectVictims(accounts, rng, waves.length);
  const victimSet = new Set(victims);
  const plans = planAttacks(waves, victims, rng);

  const drafts: Draft[] = [];
  const draft = (
    ts: number,
    account: string,
    outcome: "success" | "fail",
    attackId: number | null,
  ) => {
    const payload = kioskV1.format(generateKiosk({ rng, faker, ts, account, outcome }));
    drafts.push({ ts, account, outcome, attackId, payload, seq: drafts.length });
  };

  // Each victim's burst of failures, inside its wave and its window.
  for (const plan of plans) {
    for (const ts of plan.failTimestamps) {
      draft(ts, plan.account, "fail", plan.id);
    }
  }

  // Benign volume, all successes, emitted per wave with a carried fractional
  // accumulator so a fractional rate spreads evenly instead of rounding per tick.
  for (const wave of waves) {
    let acc = 0;
    const endTick = wave.startTick + wave.durationTicks;
    for (let tick = wave.startTick; tick < endTick; tick++) {
      acc += wave.eventsPerTick;
      while (acc >= 1) {
        acc -= 1;
        const account = accounts[Math.floor(rng() * accounts.length)] ?? accounts[0] ?? "unknown";
        draft(tick * GAME_SECONDS_PER_TICK, account, "success", null);
      }
    }
  }

  drafts.sort((a, b) => a.ts - b.ts || a.seq - b.seq);

  const events = drafts.map((d, id) => ({
    id,
    ts: d.ts,
    endpoint: kioskV1.id,
    payload: d.payload,
  }));
  const eventIdsByAttack = new Map<number, number[]>();
  drafts.forEach((d, id) => {
    if (d.attackId !== null) {
      const list = eventIdsByAttack.get(d.attackId) ?? [];
      list.push(id);
      eventIdsByAttack.set(d.attackId, list);
    }
  });

  const attacks = plans.map((plan) => attackFromPlan(plan, eventIdsByAttack.get(plan.id) ?? []));
  assertFair(drafts, victimSet, attacks);
  return { events, attacks, checkpoints, waves };
}

/**
 * A defensive invariant: prove the data is separable before handing it out. A
 * violation here is a generation bug, so it fails loudly rather than reaching a
 * player as an unwinnable run. It reads the typed drafts, not the wire payload.
 */
function assertFair(drafts: Draft[], victims: Set<string>, attacks: Attack[]): void {
  for (const attack of attacks) {
    if (attack.eventIds.length < PIN_BRUTE_FORCE_THRESHOLD) {
      throw new Error(`Attack ${attack.id} carries too little evidence.`);
    }
  }
  for (const d of drafts) {
    if (d.outcome === "fail" && victims.has(d.account) && d.attackId === null) {
      throw new Error(`Victim ${d.account} emitted a benign failure outside its burst.`);
    }
  }
  assertNoStrayThreshold(drafts, attacks);
}

/**
 * The actual separability proof: no account's failures ever cross the
 * threshold inside any PIN_BRUTE_FORCE_WINDOW_S window, except as a victim's own
 * Attack. Drafts arrive sorted by `ts`, so each account's failures are already
 * in time order; a two-pointer sweep over each account's failures finds the
 * worst window in one pass.
 */
function assertNoStrayThreshold(drafts: Draft[], attacks: Attack[]): void {
  const windowByAccount = new Map(attacks.map((a) => [a.entity, a.window]));
  const failsByAccount = new Map<string, Draft[]>();
  for (const d of drafts) {
    if (d.outcome !== "fail") {
      continue;
    }
    const list = failsByAccount.get(d.account) ?? [];
    list.push(d);
    failsByAccount.set(d.account, list);
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
  "A PIN brute force hits a station kiosk. One rider account takes five or more " +
  "wrong PINs inside five minutes. That burst is the Attack. Watch the Engine " +
  "read the raw kiosk PIN entries, normalize them, and count the failures per account. " +
  "When a burst crosses the line, it raises one Alert for the whole burst, not " +
  "one per entry. Normal traffic keeps rising in waves. Watch the Compute gauge: " +
  "the Engine holds its speed and stays ahead of the queue while it catches " +
  "every burst.";

export const kioskPinAttack: Scenario = {
  id: "kiosk-pin-attack",
  briefing,
  generate,
};
