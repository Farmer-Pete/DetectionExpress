/**
 * The kiosk-pin-attack Scenario. It composes the kiosk endpoint, preselects
 * victims, plans each victim's burst, then fills the timeline with fair benign
 * traffic. Every draw comes from the seeded `rng` and `faker`, so the same seed
 * always replays the same run.
 *
 * Fairness is the point: benign accounts never reach the spec, so the stream is
 * always separable and any scoring error means a bug in the Rule, not the data.
 */
import { en, Faker } from "@faker-js/faker";
import { randomLcg } from "d3-random";
import {
  PIN_BRUTE_FORCE_THRESHOLD,
  PIN_BRUTE_FORCE_WINDOW_S,
  SCENARIO_MINUTES,
  THREAT_RATE,
} from "../../../game/tuning";
import type { Attack } from "../../attack";
import { kioskV1, type RawKioskV1 } from "../../endpoints/kiosk/formats/kiosk-v1";
import { generateKiosk } from "../../endpoints/kiosk/internal";
import type { GeneratedRun, Scenario } from "../../scenario";
import { type AttackPlan, attackFromPlan, planAttacks } from "./attacks";

/** Accounts in the pool. THREAT_RATE of them become victims. */
const ACCOUNT_COUNT = 40;
/** Benign successes per account: a floor plus a seeded spread. */
const SUCCESS_MIN = 10;
const SUCCESS_SPREAD = 15;

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

/** Pick the victims by shuffling the pool with the seeded rng and taking a share. */
function selectVictims(accounts: string[], rng: () => number): string[] {
  const order = [...accounts];
  const victimCount = Math.round(THREAT_RATE * accounts.length);
  for (let i = 0; i < victimCount; i++) {
    const j = i + Math.floor(rng() * (order.length - i));
    const here = order[i];
    const there = order[j];
    if (here !== undefined && there !== undefined) {
      order[i] = there;
      order[j] = here;
    }
  }
  return order.slice(0, victimCount);
}

function generate(seed: number): GeneratedRun {
  const faker = new Faker({ locale: en });
  faker.seed(seed);
  const rng = randomLcg(seed);
  const timelineSeconds = SCENARIO_MINUTES * 60;

  const accounts = buildAccounts(faker);
  const victims = selectVictims(accounts, rng);
  const victimSet = new Set(victims);
  const plans = planAttacks(victims, rng, {
    timelineSeconds,
    windowSeconds: PIN_BRUTE_FORCE_WINDOW_S,
    threshold: PIN_BRUTE_FORCE_THRESHOLD,
  });
  const planByAccount = new Map<string, AttackPlan>(plans.map((p) => [p.account, p]));

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

  // The bursts first: each victim's failures inside its window.
  for (const plan of plans) {
    for (const ts of plan.failTimestamps) {
      draft(ts, plan.account, "fail", plan.id);
    }
  }

  // Then benign traffic for every account. Victims emit only successes, and only
  // outside their window, so nothing combines with the burst. Non-victims fumble
  // a few times, always kept below the threshold across the whole timeline.
  for (const account of accounts) {
    const plan = planByAccount.get(account);
    const successes = SUCCESS_MIN + Math.floor(rng() * SUCCESS_SPREAD);
    for (let i = 0; i < successes; i++) {
      const ts = Math.floor(rng() * timelineSeconds);
      if (plan && ts >= plan.window.startTs && ts <= plan.window.endTs) {
        continue; // keep the victim's window pure burst
      }
      draft(ts, account, "success", null);
    }
    if (!victimSet.has(account)) {
      const fumbles = Math.floor(rng() * PIN_BRUTE_FORCE_THRESHOLD); // 0..threshold-1
      for (let i = 0; i < fumbles; i++) {
        draft(Math.floor(rng() * timelineSeconds), account, "fail", null);
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
  return { events, attacks };
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
  const windowByAccount = new Map(attacks.map((a) => [a.account, a.window]));
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
 * The Hunt text, shown to the player before they touch the Rule. States the
 * 5-in-5-minutes pattern plainly and warns against alert spam, since one Alert
 * per Attack is the actual skill being tested.
 */
const briefing =
  "This Hunt is the kiosk PIN brute force. Five or more wrong PINs on one " +
  "account inside five minutes make an Attack. Normalize the raw kiosk " +
  "Events, then write the Match Rule to catch that burst per account and " +
  "raise one Alert per Attack, not one per wrong PIN. Catch each Attack and " +
  "Correctness climbs. Miss one, or fire extra Alerts on the same burst, and " +
  "Correctness falls.";

export const kioskPinAttack: Scenario = {
  id: "kiosk-pin-attack",
  briefing,
  generate,
};
