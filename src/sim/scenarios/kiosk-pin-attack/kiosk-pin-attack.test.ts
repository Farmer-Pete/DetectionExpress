import { describe, expect, it } from "bun:test";
import {
  CORRECTNESS_W_FN,
  CORRECTNESS_W_FP,
  CORRECTNESS_WINDOW,
  GAME_SECONDS_PER_TICK,
  INTRO_TICKS,
  LEVEL_SEED,
  PIN_BRUTE_FORCE_THRESHOLD,
  PIN_BRUTE_FORCE_WINDOW_S,
  WAVE_COUNT,
  WAVE_RATES,
} from "../../../game/tuning";
import { createScorer } from "../../correctness";
import { isRawKioskV1, type RawKioskV1 } from "../../endpoints/kiosk/formats/kiosk-v1";
import type { PipeEvent } from "../../event";
import { buildReferenceAlgorithm, referenceSource } from "./reference";
import { buildSchedule, kioskPinAttack } from "./scenario";

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

describe("kioskPinAttack", () => {
  it("has the scenario id", () => {
    expect(kioskPinAttack.id).toBe("kiosk-pin-attack");
  });
});

describe("kioskPinAttack.generate", () => {
  it("is deterministic: the same seed gives the same stream and Attacks", () => {
    const a = kioskPinAttack.generate(LEVEL_SEED);
    const b = kioskPinAttack.generate(LEVEL_SEED);
    expect(a.events).toEqual(b.events);
    expect(a.attacks).toEqual(b.attacks);
  });

  it("assigns ids in sorted-time order with no gaps", () => {
    const { events } = kioskPinAttack.generate(LEVEL_SEED);
    let prev = -1;
    events.forEach((ev, i) => {
      expect(ev.id).toBe(i);
      expect(ev.endpoint).toBe("kiosk-v1");
      expect(ev.ts).toBeGreaterThanOrEqual(prev);
      prev = ev.ts;
    });
  });

  it("gives every Attack a valid window and enough evidence", () => {
    const { events, attacks } = kioskPinAttack.generate(LEVEL_SEED);
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
        expect(record.acct).toBe(attack.account);
        expect(ev.ts).toBeGreaterThanOrEqual(attack.window.startTs);
        expect(ev.ts).toBeLessThanOrEqual(attack.window.endTs);
      }
    }
  });

  it("gives each Attack a distinct account and a non-overlapping window", () => {
    const { attacks } = kioskPinAttack.generate(LEVEL_SEED);
    const accounts = new Set(attacks.map((a) => a.account));
    expect(accounts.size).toBe(attacks.length);
    const windows = [...attacks].sort((x, y) => x.window.startTs - y.window.startTs);
    let end = -1;
    for (const attack of windows) {
      expect(attack.window.startTs).toBeGreaterThan(end);
      end = attack.window.endTs;
    }
  });

  it("is fair: only victims cross the threshold, and only via their burst", () => {
    const { events, attacks } = kioskPinAttack.generate(LEVEL_SEED);
    const victimFails = new Map(attacks.map((a) => [a.account, new Set(a.eventIds)]));
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
      const burst = victimFails.get(attack.account) ?? new Set<number>();
      const fails = events.filter((ev) => {
        const record = raw(ev);
        return record.acct === attack.account && record.res === "WRONG_PIN";
      });
      for (const ev of fails) {
        expect(burst.has(ev.id)).toBe(true);
      }
    }
  });

  it("lets the in-process reference Algorithm score 100 via the scorer", () => {
    const { events, attacks } = kioskPinAttack.generate(LEVEL_SEED);
    const scorer = createScorer(attacks, {
      threshold: PIN_BRUTE_FORCE_THRESHOLD,
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
      scorer.record(algo.match(view), ev);
    }
    scorer.finalize();

    const r = scorer.reading();
    expect(r.caught).toBe(attacks.length);
    expect(r.missed).toBe(0);
    expect(r.falseAlerts).toBe(0);
    expect(r.rolling).toBe(100);
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
    const run = kioskPinAttack.generate(LEVEL_SEED);
    expect(run.checkpoints).toEqual(buildSchedule().checkpoints);
    // The final deadline clears the last wave.
    expect(run.checkpoints[run.checkpoints.length - 1]?.clearsThroughWave).toBe(WAVE_COUNT - 1);
  });
});

describe("referenceSource", () => {
  it("imports lodash by absolute URL and exports the Rule", () => {
    expect(referenceSource).toContain('import _ from "https://esm.sh/lodash@4.17.21"');
    expect(referenceSource).toContain("export function normalize");
    expect(referenceSource).toContain("export function match");
  });
});

describe("fairness invariants stay under the M2 wave data (M3 seam 15)", () => {
  it("generates fair, separable runs across seeds without tripping assertFair", () => {
    // assertFair and assertNoStrayThreshold run inside generate and throw on any
    // violation, so a clean generate across seeds proves the invariants still hold
    // with the wave schedule in place. See GH3-PLAN.md section 9 (M3 seam 15).
    for (const seed of [LEVEL_SEED, 1, 42, 2026, 9999]) {
      const run = kioskPinAttack.generate(seed);
      expect(run.attacks.length).toBe(WAVE_RATES.length);
      for (const attack of run.attacks) {
        expect(attack.eventIds.length).toBeGreaterThanOrEqual(PIN_BRUTE_FORCE_THRESHOLD);
      }
    }
  });
});
