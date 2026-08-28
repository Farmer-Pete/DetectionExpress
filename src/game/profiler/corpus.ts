/**
 * The calibration corpus: the fixed Event stream the profiler times the player's
 * code over. It is built once from the level seed at a representative peak
 * density, so the naive scan is priced at its worst case, then looped forever.
 *
 * Each wrap advances every Event's ts by the corpus span and hands out a fresh
 * monotonic id. So time and ids move forward exactly as they would in a real run,
 * the bounded rules (see rules.ts) settle into a steady state, and no per-batch
 * module reload is needed. Pure and deterministic: the same seed rebuilds the
 * identical stream. Game-time only, no wall-clock.
 */
import { en, Faker } from "@faker-js/faker";
import { randomLcg } from "d3-random";
import { kioskV1, type RawKioskV1 } from "../../sim/endpoints/kiosk/formats/kiosk-v1";
import { generateKiosk } from "../../sim/endpoints/kiosk/internal";
import { CORPUS_ACCOUNTS, CORPUS_FAIL_SHARE, GAME_SECONDS_PER_TICK } from "../tuning";

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

/** Build a stable pool of distinct account names from the seeded faker. */
function buildAccounts(faker: Faker, count: number): string[] {
  const accounts = new Set<string>();
  while (accounts.size < count) {
    accounts.add(faker.internet.username());
  }
  return [...accounts];
}

/**
 * Build a fixed `size`-Event corpus from `seed` at `eventsPerTick` density. Events
 * are laid out in ascending game-second time; the span is one tick past the last
 * Event, so a wrap continues forward without overlapping the previous one.
 */
export function buildCorpus(seed: number, size: number, eventsPerTick: number): Corpus {
  const faker = new Faker({ locale: en });
  faker.seed(seed);
  const rng = randomLcg(seed);
  const accounts = buildAccounts(faker, CORPUS_ACCOUNTS);

  const eventsPerSecond = eventsPerTick / GAME_SECONDS_PER_TICK;
  const spanSeconds = Math.ceil(size / eventsPerSecond);

  const events: CorpusEvent[] = [];
  for (let i = 0; i < size; i++) {
    const ts = Math.floor(i / eventsPerSecond);
    const account = accounts[Math.floor(rng() * accounts.length)] ?? accounts[0] ?? "unknown";
    const outcome = rng() < CORPUS_FAIL_SHARE ? "fail" : "success";
    const payload = kioskV1.format(generateKiosk({ rng, faker, ts, account, outcome }));
    events.push({ id: i, ts, endpoint: kioskV1.id, payload });
  }
  return { events, spanSeconds };
}

/**
 * A forever iterator over the corpus. Each call returns the next Event with a
 * fresh monotonic id; each wrap shifts every ts forward by the whole span, so the
 * stream is unbounded and its time never runs backward.
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
      payload: source.payload,
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
