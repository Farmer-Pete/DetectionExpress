import { describe, expect, it } from "vitest";
import { isRawKioskV1 } from "../../sim/endpoints/kiosk/formats/kiosk-v1";
import {
  CORPUS_ACCOUNTS,
  CORPUS_PEAK_EVENTS_PER_TICK,
  CORPUS_SIZE,
  GAME_SECONDS_PER_TICK,
  LEVEL_SEED,
} from "../tuning";
import { buildCorpus, loopingCorpus } from "./corpus";
import { EXPECTED_CORPUS_FAIL_SHARE } from "./kiosk-band-calibration";

/**
 * The corpus is the fixed stream the profiler times the player's code over. It is
 * built once from the level seed at peak density, then looped: each wrap advances
 * every Event's ts by the corpus span and hands out fresh monotonic ids, so time
 * and ids keep moving forward and the bounded rules reach a steady state.
 * See GH3-PLAN.md sections 6.5 and 9.
 */
describe("buildCorpus", () => {
  it("builds exactly CORPUS_SIZE Events for the configured seed and density", () => {
    const corpus = buildCorpus(LEVEL_SEED, CORPUS_SIZE, CORPUS_PEAK_EVENTS_PER_TICK);
    expect(corpus.events.length).toBe(CORPUS_SIZE);
  });

  it("is deterministic: the same seed rebuilds the identical stream", () => {
    const a = buildCorpus(LEVEL_SEED, 200, CORPUS_PEAK_EVENTS_PER_TICK);
    const b = buildCorpus(LEVEL_SEED, 200, CORPUS_PEAK_EVENTS_PER_TICK);
    expect(a.events).toEqual(b.events);
    expect(a.spanSeconds).toBe(b.spanSeconds);
  });

  it("emits recognizable kiosk-v1 payloads with ascending timestamps", () => {
    const corpus = buildCorpus(LEVEL_SEED, 200, CORPUS_PEAK_EVENTS_PER_TICK);
    let last = Number.NEGATIVE_INFINITY;
    for (const event of corpus.events) {
      expect(isRawKioskV1(event.payload)).toBe(true);
      expect(event.ts).toBeGreaterThanOrEqual(last);
      last = event.ts;
    }
  });

  it("carries a positive span that covers the stream", () => {
    const corpus = buildCorpus(LEVEL_SEED, 200, CORPUS_PEAK_EVENTS_PER_TICK);
    const lastEvent = corpus.events[corpus.events.length - 1];
    expect(corpus.spanSeconds).toBeGreaterThan(0);
    expect(corpus.spanSeconds).toBeGreaterThan(lastEvent?.ts ?? 0);
  });

  it("contains both failures and successes, so the detectors do real work", () => {
    const corpus = buildCorpus(LEVEL_SEED, CORPUS_SIZE, CORPUS_PEAK_EVENTS_PER_TICK);
    const fails = corpus.events.filter(
      (e) => isRawKioskV1(e.payload) && e.payload.res === "WRONG_PIN",
    ).length;
    expect(fails).toBeGreaterThan(0);
    expect(fails).toBeLessThan(CORPUS_SIZE);
  });
});

describe("buildCorpus (GH102 burst-shaped corpus)", () => {
  /** The account of a kiosk-v1 event, narrowing at the boundary. */
  function accountOf(payload: unknown): string {
    if (!isRawKioskV1(payload)) {
      throw new Error("expected a kiosk-v1 payload");
    }
    return payload.acct;
  }

  it("spreads its traffic over CORPUS_ACCOUNTS distinct accounts", () => {
    const corpus = buildCorpus(LEVEL_SEED, CORPUS_SIZE, CORPUS_PEAK_EVENTS_PER_TICK);
    const accounts = new Set(corpus.events.map((e) => accountOf(e.payload)));
    expect(accounts.size).toBe(CORPUS_ACCOUNTS);
  });

  it("measures a fail share within 0.03 of the expected constant, for three seeds", () => {
    for (const seed of [LEVEL_SEED, 1, 42]) {
      const corpus = buildCorpus(seed, CORPUS_SIZE, CORPUS_PEAK_EVENTS_PER_TICK);
      const fails = corpus.events.filter(
        (e) => isRawKioskV1(e.payload) && e.payload.res === "WRONG_PIN",
      ).length;
      const share = fails / corpus.events.length;
      expect(Math.abs(share - EXPECTED_CORPUS_FAIL_SHARE)).toBeLessThan(0.03);
    }
  });

  it("yields exactly the nominal span at the shipped tuning (the span-rule pin)", () => {
    const eventsPerSecond = CORPUS_PEAK_EVENTS_PER_TICK / GAME_SECONDS_PER_TICK;
    const nominalSpan = Math.ceil(CORPUS_SIZE / eventsPerSecond);
    expect(nominalSpan).toBe(100);
    const corpus = buildCorpus(LEVEL_SEED, CORPUS_SIZE, CORPUS_PEAK_EVENTS_PER_TICK);
    // A layout regression that pushed a kept Event past the nominal span would grow
    // the span and break the exact-wrap steady state in bounded-corpus.test.ts; pin
    // it loudly here instead.
    expect(corpus.spanSeconds).toBe(nominalSpan);
  });

  it("still builds a tiny size-10 corpus whose span covers the stream", () => {
    const corpus = buildCorpus(LEVEL_SEED, 10, CORPUS_PEAK_EVENTS_PER_TICK);
    expect(corpus.events.length).toBe(10);
    const lastTs = corpus.events[corpus.events.length - 1]?.ts ?? 0;
    expect(corpus.spanSeconds).toBeGreaterThan(lastTs);
  });
});

describe("loopingCorpus", () => {
  it("hands out strictly monotonic ids across the wrap boundary", () => {
    const corpus = buildCorpus(LEVEL_SEED, 10, CORPUS_PEAK_EVENTS_PER_TICK);
    const next = loopingCorpus(corpus);
    let lastId = -1;
    for (let i = 0; i < 25; i++) {
      const event = next();
      expect(event.id).toBe(lastId + 1);
      lastId = event.id;
    }
  });

  it("advances every ts by the span on each wrap", () => {
    const corpus = buildCorpus(LEVEL_SEED, 10, CORPUS_PEAK_EVENTS_PER_TICK);
    const next = loopingCorpus(corpus);
    const firstWrap = Array.from({ length: 10 }, () => next().ts);
    const secondWrap = Array.from({ length: 10 }, () => next().ts);
    for (let i = 0; i < 10; i++) {
      expect(secondWrap[i]).toBe((firstWrap[i] ?? 0) + corpus.spanSeconds);
    }
  });

  it("keeps ts non-decreasing forever, so the detectors see in-order time", () => {
    const corpus = buildCorpus(LEVEL_SEED, 50, CORPUS_PEAK_EVENTS_PER_TICK);
    const next = loopingCorpus(corpus);
    let last = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < 500; i++) {
      const ts = next().ts;
      expect(ts).toBeGreaterThanOrEqual(last);
      last = ts;
    }
  });
});
