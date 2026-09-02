import { describe, expect, it } from "vitest";
import {
  CORRECTNESS_W_FN,
  CORRECTNESS_W_FP,
  CORRECTNESS_WINDOW,
  GAME_SECONDS_PER_TICK,
  INTRO_TICKS,
  LEVEL_SEED,
  WAVE_COUNT,
  WAVE_RATES,
} from "../../../game/tuning";
import { admitArrivals } from "../../actors/admission";
import { createScorer } from "../../correctness";
import { isRawKioskV1, type RawKioskV1 } from "../../endpoints/kiosk/formats/kiosk-v1";
import type { PipeEvent } from "../../event";
import type { GeneratedRun } from "../../scenario";
import { buildSchedule } from "../../schedule";
import { buildReferenceAlgorithm } from "./reference";
import { buildBlueprint, pinBruteForce } from "./scenario";
import { ATTACKS_PER_WAVE, PIN_BRUTE_FORCE_THRESHOLD, PIN_BRUTE_FORCE_WINDOW_S } from "./tuning";

/** The total attackers across all waves; the globally distinct victim count. */
const VICTIM_COUNT = ATTACKS_PER_WAVE.reduce((sum, n) => sum + n, 0);

/** The run ends at the final deadline: the last checkpoint's tick, in game seconds. */
function deadlineSeconds(): number {
  const checkpoints = buildSchedule().checkpoints;
  const last = checkpoints[checkpoints.length - 1];
  return (last?.atTick ?? 0) * GAME_SECONDS_PER_TICK;
}

/** Read an Event's kiosk-v1 payload, narrowing at the boundary. */
function raw(ev: PipeEvent): RawKioskV1 {
  if (!isRawKioskV1(ev.payload)) {
    throw new Error("expected a kiosk-v1 payload");
  }
  return ev.payload;
}

/** Fail-event timestamps for one account, in stream order. */
function failTimesByAccount(events: PipeEvent[]): Map<string, number[]> {
  const byAccount = new Map<string, number[]>();
  for (const ev of events) {
    const record = raw(ev);
    if (record.res === "WRONG_PIN") {
      const list = byAccount.get(record.acct) ?? [];
      list.push(ev.ts);
      byAccount.set(record.acct, list);
    }
  }
  return byAccount;
}

/** The most failures for this account inside any sliding window. */
function maxFailsInWindow(times: number[], windowSeconds: number): number {
  let worst = 0;
  for (let i = 0; i < times.length; i++) {
    const start = times[i] ?? 0;
    let count = 0;
    for (let j = i; j < times.length && (times[j] ?? 0) - start < windowSeconds; j++) {
      count += 1;
    }
    worst = Math.max(worst, count);
  }
  return worst;
}

describe("pinBruteForce", () => {
  it("has the scenario id", () => {
    expect(pinBruteForce.id).toBe("pin-brute-force");
  });
});

describe("pinBruteForce.generate", () => {
  it("is deterministic: the same seed gives the same stream and Attacks", () => {
    const a = pinBruteForce.generate(LEVEL_SEED);
    const b = pinBruteForce.generate(LEVEL_SEED);
    expect(a.events).toEqual(b.events);
    expect(a.attacks).toEqual(b.attacks);
  });

  it("assigns ids in sorted-time order with no gaps", () => {
    const { events } = pinBruteForce.generate(LEVEL_SEED);
    let prev = -1;
    events.forEach((ev, i) => {
      expect(ev.id).toBe(i);
      expect(ev.endpoint).toBe("kiosk-v1");
      expect(ev.ts).toBeGreaterThanOrEqual(prev);
      prev = ev.ts;
    });
  });

  it("gives every Attack a valid window and enough evidence", () => {
    const { events, attacks } = pinBruteForce.generate(LEVEL_SEED);
    const byId = new Map(events.map((ev) => [ev.id, ev]));
    const deadline = deadlineSeconds();
    expect(attacks.length).toBeGreaterThan(0);
    for (const attack of attacks) {
      expect(attack.reason).toBe("pin_brute_force");
      expect(attack.eventIds.length).toBeGreaterThanOrEqual(PIN_BRUTE_FORCE_THRESHOLD);
      expect(attack.window.endTs).toBeLessThan(deadline);
      for (const id of attack.eventIds) {
        const ev = byId.get(id);
        expect(ev).toBeDefined();
        if (!ev) {
          continue;
        }
        const record = raw(ev);
        expect(record.res).toBe("WRONG_PIN");
        expect(record.acct).toBe(attack.entity);
        expect(ev.ts).toBeGreaterThanOrEqual(attack.window.startTs);
        expect(ev.ts).toBeLessThanOrEqual(attack.window.endTs);
      }
    }
  });

  it("carries the multi-attacker count on globally distinct victims", () => {
    const { attacks } = pinBruteForce.generate(LEVEL_SEED);
    // 2 + 4 + 8 bursts, each on its own distinct victim account.
    expect(attacks.length).toBe(VICTIM_COUNT);
    const accounts = new Set(attacks.map((a) => a.entity));
    expect(accounts.size).toBe(attacks.length);
    // Attack ids run 1..14 in plan order.
    expect(attacks.map((a) => a.id)).toEqual(
      Array.from({ length: VICTIM_COUNT }, (_v, i) => i + 1),
    );
    // Bursts on distinct accounts may overlap in time; the detector counts per
    // account, so overlap is fair and is NOT asserted against here.
  });

  it("is fair: only victims cross the threshold, and only via their burst", () => {
    const { events, attacks } = pinBruteForce.generate(LEVEL_SEED);
    const victimFails = new Map(attacks.map((a) => [a.entity, new Set(a.eventIds)]));
    const failTimes = failTimesByAccount(events);

    for (const [account, times] of failTimes) {
      if (victimFails.has(account)) {
        continue; // victims are allowed their burst
      }
      expect(maxFailsInWindow(times, PIN_BRUTE_FORCE_WINDOW_S)).toBeLessThan(
        PIN_BRUTE_FORCE_THRESHOLD,
      );
    }

    // A victim's only failure Events are exactly its burst.
    for (const attack of attacks) {
      const burst = victimFails.get(attack.entity) ?? new Set<number>();
      const fails = events.filter((ev) => {
        const record = raw(ev);
        return record.acct === attack.entity && record.res === "WRONG_PIN";
      });
      for (const ev of fails) {
        expect(burst.has(ev.id)).toBe(true);
      }
    }
  });

  it("lets the in-process reference Algorithm score 100 via the scorer", () => {
    const { events, attacks } = pinBruteForce.generate(LEVEL_SEED);
    const scorer = createScorer(attacks, {
      window: CORRECTNESS_WINDOW,
      wFn: CORRECTNESS_W_FN,
      wFp: CORRECTNESS_W_FP,
    });
    // A fresh instance: the shared singleton's mutable state could carry
    // cross-test corruption if another test also drove it.
    const algo = buildReferenceAlgorithm();

    for (const ev of events) {
      const norm = algo.normalize(raw(ev));
      const view = { ...norm, id: ev.id, ts: ev.ts, endpoint: ev.endpoint };
      // Hand the scorer the findings the way runDetect does: the scorer skips
      // partials itself, so pass them all as ScoredFinding (no subject here).
      const scored = algo.detect(view).map((finding) => ({ finding }));
      scorer.record(scored, ev);
    }
    scorer.finalize();

    const r = scorer.reading();
    expect(r.caught).toBe(attacks.length);
    expect(r.missed).toBe(0);
    expect(r.falseAlerts).toBe(0);
    expect(r.rolling).toBe(100);
  });
});

describe("pinBruteForce.generate benign fumbles and sign-ins (GH102)", () => {
  const run = pinBruteForce.generate(LEVEL_SEED);
  const successes = run.events.filter((ev) => raw(ev).res === "OK");
  const fails = run.events.filter((ev) => raw(ev).res === "WRONG_PIN");
  const attackFailIds = new Set(run.attacks.flatMap((a) => a.eventIds));

  it("emits one successful sign-in per admitted arrival slot", () => {
    const slots = admitArrivals(buildSchedule().waves).length;
    expect(successes.length).toBe(slots);
  });

  it("carries benign fumbles: some fails belong to no Attack", () => {
    const fumbleFails = fails.filter((ev) => !attackFailIds.has(ev.id));
    expect(fumbleFails.length).toBeGreaterThan(0);
  });

  it("splits every fail into an attack fail or a benign fumble, and nothing else", () => {
    const attackFails = fails.filter((ev) => attackFailIds.has(ev.id));
    const fumbleFails = fails.filter((ev) => !attackFailIds.has(ev.id));
    expect(attackFails.length + fumbleFails.length).toBe(fails.length);
    // Total events = benign successes + benign fumbles + attack fails.
    expect(run.events.length).toBe(successes.length + fumbleFails.length + attackFails.length);
  });
});

describe("buildSchedule (M2 schedule invariant)", () => {
  it("emits one wave per rate, half-open and rising, with no overlap", () => {
    const { waves } = buildSchedule();
    expect(waves.length).toBe(WAVE_COUNT);
    expect(WAVE_COUNT).toBe(WAVE_RATES.length);
    expect(waves[0]?.startTick).toBe(INTRO_TICKS); // the intro precedes Wave 1
    let prevEnd = -1;
    let prevRate = -1;
    for (const wave of waves) {
      expect(wave.durationTicks).toBeGreaterThan(0);
      expect(wave.startTick).toBeGreaterThanOrEqual(prevEnd); // [start, end): no overlap
      expect(wave.eventsPerTick).toBeGreaterThan(prevRate); // rates climb wave over wave
      prevEnd = wave.startTick + wave.durationTicks;
      prevRate = wave.eventsPerTick;
    }
  });

  it("puts each checkpoint a drain gap past its wave, in tick order, next wave at/after it", () => {
    const { waves, checkpoints } = buildSchedule();
    expect(checkpoints.length).toBe(waves.length);
    let prevTick = -1;
    checkpoints.forEach((cp, i) => {
      const wave = waves[i];
      expect(wave).toBeDefined();
      if (!wave) return;
      expect(cp.clearsThroughWave).toBe(i);
      expect(cp.atTick).toBeGreaterThan(wave.startTick + wave.durationTicks); // past the wave end
      expect(cp.atTick).toBeGreaterThan(prevTick); // strictly ascending
      const nextWave = waves[i + 1];
      if (nextWave) {
        expect(nextWave.startTick).toBeGreaterThanOrEqual(cp.atTick); // no wave admitted before it
      }
      prevTick = cp.atTick;
    });
  });

  it("carries the checkpoints through into the generated run unchanged", () => {
    const run = pinBruteForce.generate(LEVEL_SEED);
    expect(run.checkpoints).toEqual(buildSchedule().checkpoints);
    // The final deadline clears the last wave.
    expect(run.checkpoints[run.checkpoints.length - 1]?.clearsThroughWave).toBe(WAVE_COUNT - 1);
  });

  it("carries the waves through into the generated run unchanged (GH38+40-PLAN.md Part 1)", () => {
    const run = pinBruteForce.generate(LEVEL_SEED);
    expect(run.waves).toEqual(buildSchedule().waves);
  });
});

describe("in-order stream keeps the hidden #5 seed (GH3-PLAN.md 6.5, 11)", () => {
  it("emits every Event in non-decreasing ts across seeds, so Slice 2 has no late Event", () => {
    // The Optimization's incremental tally evicts past its window on the in-order
    // assumption (optimization.ts). Slice 2 must never emit a late or out-of-order
    // Event, or that assumption — the seed a later slice (#5) reveals — would
    // surface early and the tally would under-count. Lock the property here so the
    // seed stays hidden and the tally stays correct this slice.
    for (const seed of [LEVEL_SEED, 1, 42, 2026, 9999]) {
      const { events } = pinBruteForce.generate(seed);
      let prev = Number.NEGATIVE_INFINITY;
      for (const ev of events) {
        expect(ev.ts).toBeGreaterThanOrEqual(prev);
        prev = ev.ts;
      }
    }
  });
});

// The Rolldown-codegen shape of `referenceSource` (the teaching import, the hoisted
// `normalize`/`detect`/`export` footer) is already asserted in `reference.test.ts` and
// `engine-assembler.test.ts`; a third copy here would only need updating in lockstep on
// any Rolldown format change, so it is not repeated in this file.

// GH42-PLAN.md's minimal merge seam: `partition` rides the PUBLIC `Scenario.generate`
// contract, not a scenario-specific function only this module's own tests could reach.
// Every case below drives it through `pinBruteForce.generate` (the `Scenario` object),
// exactly as `mergeRuns`'s own caller (`game/merge-runs.test.ts`) does.
describe("generate's partition parameter (GH42-PLAN.md's minimal merge seam)", () => {
  it("with no partition, generates the same run as an explicit undefined partition", () => {
    expect(pinBruteForce.generate(LEVEL_SEED)).toEqual(
      pinBruteForce.generate(LEVEL_SEED, undefined),
    );
  });

  it("draws disjoint accounts for two different partitions, even across different seeds", () => {
    const a = pinBruteForce.generate(LEVEL_SEED, 0);
    const b = pinBruteForce.generate(2026, 1);
    const accountsOf = (run: GeneratedRun): Set<string> =>
      new Set(run.attacks.map((attack) => attack.entity));
    const aAccounts = accountsOf(a);
    const bAccounts = accountsOf(b);
    // Guards against a vacuous pass: an empty set would make the loop below check
    // nothing and still report disjoint.
    expect(aAccounts.size).toBeGreaterThan(0);
    expect(bAccounts.size).toBeGreaterThan(0);
    for (const account of aAccounts) {
      expect(bAccounts.has(account)).toBe(false);
    }
  });

  it("is deterministic for a given seed and partition", () => {
    const a = pinBruteForce.generate(LEVEL_SEED, 1);
    const b = pinBruteForce.generate(LEVEL_SEED, 1);
    expect(a).toEqual(b);
  });
});

describe("fairness invariants stay under the M2 wave data (M3 seam 15)", () => {
  it("generates fair, separable runs across seeds without tripping assertFair", () => {
    // assertFair and assertNoStrayThreshold run inside generate and throw on any
    // violation, so a clean generate across seeds proves the invariants still hold
    // with the wave schedule in place. See GH3-PLAN.md section 9 (M3 seam 15).
    for (const seed of [LEVEL_SEED, 1, 42, 2026, 9999]) {
      const run = pinBruteForce.generate(seed);
      expect(run.attacks.length).toBe(VICTIM_COUNT);
      for (const attack of run.attacks) {
        expect(attack.eventIds.length).toBeGreaterThanOrEqual(PIN_BRUTE_FORCE_THRESHOLD);
      }
    }
  });
});

describe('buildBlueprint("steady") (GH124-PLAN.md Checkpoint 3)', () => {
  it('builds cleanly off a gap-0 contiguous schedule: no throw despite the successor-gap shape assertWaveScheduleOrdered rejects in "waves" mode', () => {
    expect(() => buildBlueprint(LEVEL_SEED, "steady")).not.toThrow();
  });

  it("carries the steady schedule's contiguous waves and single terminal checkpoint through", () => {
    const blueprint = buildBlueprint(LEVEL_SEED, "steady");
    expect(blueprint.scheduleMode).toBe("steady");
    expect(blueprint.checkpoints.length).toBe(1);
    expect(blueprint.waves).toEqual(buildSchedule("steady").waves);
  });

  it("still plans a valid, separable attack across every wave: exactly VICTIM_COUNT attacks, each over threshold", () => {
    const blueprint = buildBlueprint(LEVEL_SEED, "steady");
    expect(blueprint.precomposed.attacks.length).toBe(VICTIM_COUNT);
    for (const attack of blueprint.precomposed.attacks) {
      expect(attack.eventIds.length).toBeGreaterThanOrEqual(PIN_BRUTE_FORCE_THRESHOLD);
    }
  });

  it('defaults to "waves" mode when scheduleMode is omitted, unchanged from before this checkpoint', () => {
    const blueprint = buildBlueprint(LEVEL_SEED);
    expect(blueprint.scheduleMode).toBe("waves");
    expect(blueprint.waves).toEqual(buildSchedule().waves);
  });
});
