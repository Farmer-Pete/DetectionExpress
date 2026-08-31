/**
 * The calibration corpus: the fixed Event stream the profiler times the player's
 * code over. It is built once from the level seed at a representative peak density,
 * so the naive scan is priced at its worst case, then looped forever.
 *
 * Since GH102 it is built from the SAME actor cast the kiosk scenario uses
 * (`cast.ts`), with no ground truth. The cast is co-located pairs: each pair is one
 * benign patron (a single success, no fumbles) and one PIN attacker (a 5..8-fail
 * burst one tick apart, deep windows on purpose) on one account. The patron signs
 * in at the pair's slot tick and the attacker's first fail lands on that same tick,
 * but the burst's remaining fails trail behind the success, so the sorted stream's
 * time-tail is mostly fails. Slicing to the first `size` events therefore cuts a
 * fail-heavy tail and lands the kept fail share a little BELOW the per-pair mean;
 * `EXPECTED_CORPUS_FAIL_SHARE` (kiosk-band-calibration.ts) subtracts that
 * structural offset so the band model prices the corpus the profiler actually uses.
 *
 * Each wrap advances every Event's ts by the corpus span and hands out a fresh
 * monotonic id, so time and ids move forward exactly as they would in a real run,
 * the bounded rules (see rules.ts) settle into a steady state, and no per-batch
 * module reload is needed. Pure and deterministic: the same seed rebuilds the
 * identical stream. Game-time only, no wall-clock.
 */
import { randomLcg } from "d3-random";
import { type Actor, runActors, type TimedReading } from "../../sim/actors/actor";
import { composeRun } from "../../sim/actors/compose";
import { isRawKioskV1, kioskV1, type RawKioskV1 } from "../../sim/endpoints/kiosk/formats/kiosk-v1";
import { PIN_BRUTE_FORCE_THRESHOLD } from "../../sim/scenarios/pin-brute-force/tuning";
import { distanceTable } from "../../sim/world/distance";
import { buildTimetable } from "../../sim/world/timetable";
import { world } from "../../sim/world/world";
import type { WorldEnv, WorldReading } from "../../sim/world-reading";
import { defaultEntry } from "../registry";
import { CORPUS_ACCOUNTS, GAME_SECONDS_PER_TICK } from "../tuning";

/** The cast primitives, read through the registry's corpus contract, never a
 *  scenario folder directly (GH42 code review). */
const pinBruteForceCorpus = defaultEntry.corpus;

/** One corpus Event: an engine envelope over a raw kiosk-v1 payload. */
export interface CorpusEvent {
  id: number;
  ts: number;
  endpoint: string;
  payload: RawKioskV1;
}

/** The built corpus: the sorted Events and the game-second span they cover. */
export interface Corpus {
  events: CorpusEvent[];
  spanSeconds: number;
}

/**
 * The longest burst in ticks: the max of the `threshold + floor(rng()*4)` fail-count
 * draw below (also `planAttacks`'s draw). Derived, not a literal, so a threshold
 * retune moves the slot spread and the horizon together and bursts never spill past
 * the nominal span (which would break the bounded-corpus divisibility invariant).
 */
const MAX_BURST_TICKS = PIN_BRUTE_FORCE_THRESHOLD + 3;

/**
 * Build a fixed `size`-Event corpus from `seed` at `eventsPerTick` density. It lays
 * `N = ceil(size / (1 + threshold))` co-located pairs across the nominal span. Each
 * pair emits at least `1 + threshold` (6) events, so the stream always reaches
 * `size`; the sorted stream is sliced to the first `size` (a time-tail cut that
 * drops mostly trailing fails). The span is the nominal span, grown only if the last
 * kept Event would otherwise fall outside it, so a wrap never overlaps the previous.
 */
export function buildCorpus(seed: number, size: number, eventsPerTick: number): Corpus {
  const rng = randomLcg(seed);

  const eventsPerSecond = eventsPerTick / GAME_SECONDS_PER_TICK;
  const nominalSpan = Math.ceil(size / eventsPerSecond);
  const nominalSpanTicks = Math.ceil(nominalSpan / GAME_SECONDS_PER_TICK);
  const pairCount = Math.ceil(size / (1 + PIN_BRUTE_FORCE_THRESHOLD));
  // The tick range slots spread over, leaving ARRIVE_LEAD_TICKS of pre-roll and a
  // MAX_BURST_TICKS tail for the longest burst. Clamped to at least 1 so a tiny
  // corpus (whose nominal span cannot hold a burst) still lays every pair at the
  // lead tick.
  const usableTicks = Math.max(
    1,
    nominalSpanTicks - pinBruteForceCorpus.arriveLeadTicks - MAX_BURST_TICKS,
  );

  const pools = pinBruteForceCorpus.buildIdentityPools(rng, world, CORPUS_ACCOUNTS);
  const actors: Actor<WorldReading, WorldEnv>[] = [];
  for (let k = 0; k < pairCount; k++) {
    const account = pinBruteForceCorpus.pickSeeded(pools.accounts, rng);
    const station = pinBruteForceCorpus.pickSeeded(pools.stations, rng);
    const terminal = pinBruteForceCorpus.pickSeeded(pools.terminals, rng);
    // Between threshold and threshold + 3 fails, the same distribution planAttacks
    // draws; laid one tick apart for deliberately deep detection windows.
    const failCount = PIN_BRUTE_FORCE_THRESHOLD + Math.floor(rng() * 4);
    const slotTick =
      pinBruteForceCorpus.arriveLeadTicks + Math.floor((k * usableTicks) / pairCount);

    actors.push(
      pinBruteForceCorpus.assemblePatron({
        id: `patron-${k}`,
        account,
        station,
        terminal,
        startTick: slotTick,
        dwellTicks: 1,
        fumbleFails: 0,
      }),
    );
    const failTimestamps = Array.from(
      { length: failCount },
      (_v, i) => (slotTick + i) * GAME_SECONDS_PER_TICK,
    );
    const { actor } = pinBruteForceCorpus.assembleAttacker({
      id: `attack-${k}`,
      attackId: k + 1,
      account,
      station,
      terminal,
      failTimestamps,
    });
    actors.push(actor);
  }

  const env: WorldEnv = {
    world,
    distances: distanceTable(world),
    timetable: buildTimetable(world),
  };
  // The longest burst fully covered under the half-open bound: the last slot sits at
  // most `usableTicks` past the lead, plus the longest burst's tail, plus one.
  const horizon = nominalSpanTicks + pinBruteForceCorpus.arriveLeadTicks + MAX_BURST_TICKS + 1;
  const timed = runActors({ actors, env, runSeed: seed, horizon });

  // No ground truth in the corpus: omit attackIdOf, so eventIdsByAttack is empty.
  const composed = composeRun<TimedReading<WorldReading>>({
    readings: timed,
    tsOf: (t) => t.reading.reading.ts,
    format: (t) => {
      if (t.reading.sensor !== "kiosk") {
        throw new Error(`corpus composed a ${t.reading.sensor} reading.`);
      }
      return kioskV1.format(t.reading.reading);
    },
    endpointIdOf: () => kioskV1.id,
  });

  // Slice the time-sorted stream to the first `size`; ids stay 0..size-1.
  const events: CorpusEvent[] = composed.events.slice(0, size).map((event) => {
    if (!isRawKioskV1(event.payload)) {
      throw new Error("buildCorpus: composed a non-kiosk-v1 payload.");
    }
    return { id: event.id, ts: event.ts, endpoint: event.endpoint, payload: event.payload };
  });

  // Span rule: the nominal span, grown only so the last kept Event ends strictly
  // inside it. At the shipped tuning the co-located layout ends every kept Event
  // inside the nominal span, so the span stays exactly the nominal one.
  const lastKeptTs = events[events.length - 1]?.ts ?? 0;
  const spanSeconds = Math.max(nominalSpan, lastKeptTs + GAME_SECONDS_PER_TICK);
  return { events, spanSeconds };
}

/**
 * A forever iterator over the corpus. Each call returns the next Event with a
 * fresh monotonic id; each wrap shifts every ts forward by the whole span, so the
 * stream is unbounded and its time never runs backward.
 *
 * Every Event gets its own payload copy, never the shared source object. Player
 * `normalize` may mutate its argument, so a shared reference would let one wrap's
 * edit bleed into a later wrap and into the separate anchor run, skewing C/A. The
 * copy is shallow because `RawKioskV1` is flat (all primitive fields).
 */
export function loopingCorpus(corpus: Corpus): () => CorpusEvent {
  const base = corpus.events;
  const first = base[0];
  if (first === undefined) {
    throw new RangeError("cannot loop an empty corpus");
  }
  let index = 0;
  let wrap = 0;
  let id = 0;
  return (): CorpusEvent => {
    const source = base[index] ?? first;
    const event: CorpusEvent = {
      id: id,
      ts: source.ts + wrap * corpus.spanSeconds,
      endpoint: source.endpoint,
      payload: { ...source.payload },
    };
    id++;
    index++;
    if (index >= base.length) {
      index = 0;
      wrap++;
    }
    return event;
  };
}
