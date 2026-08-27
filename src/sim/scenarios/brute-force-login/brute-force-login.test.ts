import { describe, expect, it } from "bun:test";
import {
  BRUTE_FORCE_THRESHOLD,
  BRUTE_FORCE_WINDOW_S,
  CORRECTNESS_W_FN,
  CORRECTNESS_W_FP,
  CORRECTNESS_WINDOW,
  LEVEL_SEED,
  SCENARIO_MINUTES,
} from "../../../game/tuning";
import { createScorer } from "../../correctness";
import { isRawAuthV1, type RawAuthV1 } from "../../endpoints/auth/formats/auth-v1";
import type { PipeEvent } from "../../event";
import { referenceAlgorithm, referenceSource } from "./reference";
import { bruteForceLogin } from "./scenario";

const TIMELINE = SCENARIO_MINUTES * 60;

/** Read an Event's auth-v1 payload, narrowing at the boundary. */
function raw(ev: PipeEvent): RawAuthV1 {
  if (!isRawAuthV1(ev.payload)) {
    throw new Error("expected an auth-v1 payload");
  }
  return ev.payload;
}

/** Fail-event timestamps for one account, in stream order. */
function failTimesByAccount(events: PipeEvent[]): Map<string, number[]> {
  const byAccount = new Map<string, number[]>();
  for (const ev of events) {
    const record = raw(ev);
    if (record.res === "FAILURE") {
      const list = byAccount.get(record.u) ?? [];
      list.push(ev.ts);
      byAccount.set(record.u, list);
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

describe("bruteForceLogin.generate", () => {
  it("is deterministic: the same seed gives the same stream and Attacks", () => {
    const a = bruteForceLogin.generate(LEVEL_SEED);
    const b = bruteForceLogin.generate(LEVEL_SEED);
    expect(a.events).toEqual(b.events);
    expect(a.attacks).toEqual(b.attacks);
  });

  it("assigns ids in sorted-time order with no gaps", () => {
    const { events } = bruteForceLogin.generate(LEVEL_SEED);
    let prev = -1;
    events.forEach((ev, i) => {
      expect(ev.id).toBe(i);
      expect(ev.endpoint).toBe("auth-v1");
      expect(ev.ts).toBeGreaterThanOrEqual(prev);
      prev = ev.ts;
    });
  });

  it("gives every Attack a valid window and enough evidence", () => {
    const { events, attacks } = bruteForceLogin.generate(LEVEL_SEED);
    const byId = new Map(events.map((ev) => [ev.id, ev]));
    expect(attacks.length).toBeGreaterThan(0);
    for (const attack of attacks) {
      expect(attack.reason).toBe("brute_force");
      expect(attack.eventIds.length).toBeGreaterThanOrEqual(BRUTE_FORCE_THRESHOLD);
      expect(attack.window.endTs).toBeLessThan(TIMELINE);
      for (const id of attack.eventIds) {
        const ev = byId.get(id);
        expect(ev).toBeDefined();
        if (!ev) {
          continue;
        }
        const record = raw(ev);
        expect(record.res).toBe("FAILURE");
        expect(record.u).toBe(attack.account);
        expect(ev.ts).toBeGreaterThanOrEqual(attack.window.startTs);
        expect(ev.ts).toBeLessThanOrEqual(attack.window.endTs);
      }
    }
  });

  it("gives each Attack a distinct account and a non-overlapping window", () => {
    const { attacks } = bruteForceLogin.generate(LEVEL_SEED);
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
    const { events, attacks } = bruteForceLogin.generate(LEVEL_SEED);
    const victimFails = new Map(attacks.map((a) => [a.account, new Set(a.eventIds)]));
    const failTimes = failTimesByAccount(events);

    for (const [account, times] of failTimes) {
      if (victimFails.has(account)) {
        continue; // victims are allowed their burst
      }
      expect(maxFailsInWindow(times, BRUTE_FORCE_WINDOW_S)).toBeLessThan(BRUTE_FORCE_THRESHOLD);
    }

    // A victim's only failure Events are exactly its burst.
    for (const attack of attacks) {
      const burst = victimFails.get(attack.account) ?? new Set<number>();
      const fails = events.filter((ev) => {
        const record = raw(ev);
        return record.u === attack.account && record.res === "FAILURE";
      });
      for (const ev of fails) {
        expect(burst.has(ev.id)).toBe(true);
      }
    }
  });

  it("lets the in-process reference Algorithm score 100 via the scorer", () => {
    const { events, attacks } = bruteForceLogin.generate(LEVEL_SEED);
    const scorer = createScorer(attacks, {
      threshold: BRUTE_FORCE_THRESHOLD,
      window: CORRECTNESS_WINDOW,
      wFn: CORRECTNESS_W_FN,
      wFp: CORRECTNESS_W_FP,
    });

    for (const ev of events) {
      const norm = referenceAlgorithm.normalize(raw(ev));
      const view = { ...norm, id: ev.id, ts: ev.ts, endpoint: ev.endpoint };
      scorer.record(referenceAlgorithm.match(view), ev);
    }
    scorer.finalize();

    const r = scorer.reading();
    expect(r.caught).toBe(attacks.length);
    expect(r.missed).toBe(0);
    expect(r.falseAlerts).toBe(0);
    expect(r.rolling).toBe(100);
  });
});

describe("referenceSource", () => {
  it("imports lodash by absolute URL and exports the Rule", () => {
    expect(referenceSource).toContain('import _ from "https://esm.sh/lodash@4.17.21"');
    expect(referenceSource).toContain("export function normalize");
    expect(referenceSource).toContain("export function match");
  });
});
