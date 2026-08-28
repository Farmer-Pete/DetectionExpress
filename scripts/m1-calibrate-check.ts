/**
 * M1 validation harness (human checkpoint, not a CI gate). It times a spread of
 * sample rules over the real profiler and prints each rule's measured C/A and its
 * stability across repeats. A poor rule must measure slow, a good rule fast, with
 * a stable ordering. The absolute numbers vary run to run; that is expected. See
 * GH3-PLAN.md section 13.
 *
 * Run: `bun run m1:check`.
 */

import { calibrate, type ProfilerRule } from "../src/game/profiler/calibrate";
import type { MeasureConfig } from "../src/game/profiler/measure";
import { buildDefaultCorpus, performanceTimer } from "../src/game/profiler/profile";
import {
  type Detector,
  type MatchView,
  makeIncrementalTally,
  makeNaiveScan,
  normalizeKiosk,
  SCAN_WINDOW_S,
} from "../src/game/profiler/rules";
import type { Alert } from "../src/sim/alert";

/** A lighter protocol than production, so the harness finishes in a few seconds. */
const HARNESS_CONFIG: MeasureConfig = { warmupMs: 40, batchMs: 40, batches: 3 };
const REPEATS = 5;
const THRESHOLD = 5;

/** Wrap a detector as the rule the calibrator prices. */
function ruleOf(detector: Detector): ProfilerRule {
  return { normalize: normalizeKiosk, match: (view) => detector.step(view) };
}

/**
 * A deliberately poor rule: on every fail it re-scans a bounded recent buffer with
 * a nested loop, wasting O(n^2) work before it decides. Correct, but slow.
 */
function makePoorDetector(): Detector {
  const recent: MatchView[] = [];
  const firing = new Set<string>();
  return {
    step(event: MatchView): Alert | null {
      if (event.outcome !== "fail") {
        return null;
      }
      recent.push(event);
      while (recent.length > 200) {
        recent.shift();
      }
      // Wasted nested scan: count, for each recent fail, how many others on the
      // same account sit within the window. Only the diagonal count is used.
      let count = 0;
      for (const a of recent) {
        if (a.account !== event.account) {
          continue;
        }
        let near = 0;
        for (const b of recent) {
          if (b.account === event.account && Math.abs(a.ts - b.ts) < SCAN_WINDOW_S) {
            near++;
          }
        }
        if (a.id === event.id) {
          count = near;
        }
      }
      if (count < THRESHOLD) {
        firing.delete(event.account);
        return null;
      }
      if (firing.has(event.account)) {
        return null;
      }
      firing.add(event.account);
      return { reason: "pin_brute_force", at: event.ts, events: [event.id] };
    },
    retained: () => recent.length,
  };
}

/**
 * A per-account bucket: keep each account's recent fails in an array and drop the
 * stale front with a pointer instead of re-filtering the whole array. Between the
 * naive scan and the incremental tally in cost.
 */
function makeBucketDetector(): Detector {
  const buckets = new Map<string, { fails: number[]; head: number }>();
  const firing = new Set<string>();
  return {
    step(event: MatchView): Alert | null {
      if (event.outcome !== "fail") {
        return null;
      }
      const bucket = buckets.get(event.account) ?? { fails: [], head: 0 };
      bucket.fails.push(event.ts);
      const cutoff = event.ts - SCAN_WINDOW_S;
      while (bucket.head < bucket.fails.length && (bucket.fails[bucket.head] ?? 0) <= cutoff) {
        bucket.head++;
      }
      if (bucket.head > 256) {
        bucket.fails = bucket.fails.slice(bucket.head);
        bucket.head = 0;
      }
      buckets.set(event.account, bucket);
      const count = bucket.fails.length - bucket.head;
      if (count < THRESHOLD) {
        firing.delete(event.account);
        return null;
      }
      if (firing.has(event.account)) {
        return null;
      }
      firing.add(event.account);
      return { reason: "pin_brute_force", at: event.ts, events: [event.id] };
    },
    retained: () => {
      let total = 0;
      for (const bucket of buckets.values()) {
        total += bucket.fails.length - bucket.head;
      }
      return total;
    },
  };
}

/**
 * A heavier rule standing in for one that pulls a library: it serializes each
 * Event to JSON and back before the naive scan. (An offline harness cannot import
 * a URL module, so this prices comparable per-Event overhead instead.) The extra
 * work sits on top of the naive scan, so it measures a shade slower than it.
 */
function makeHeavyDetector(): Detector {
  const inner = makeNaiveScan();
  return {
    step(event: MatchView): Alert | null {
      const round = JSON.parse(JSON.stringify(event));
      const view: MatchView = {
        account: round.account,
        terminal: round.terminal,
        outcome: round.outcome,
        id: round.id,
        ts: round.ts,
        endpoint: round.endpoint,
      };
      return inner.step(view);
    },
    retained: () => inner.retained(),
  };
}

interface Sample {
  name: string;
  make: () => ProfilerRule;
}

const samples: Sample[] = [
  { name: "poor (nested loops)", make: () => ruleOf(makePoorDetector()) },
  { name: "naive raw-log scan", make: () => ruleOf(makeNaiveScan()) },
  { name: "per-account bucket", make: () => ruleOf(makeBucketDetector()) },
  { name: "incremental tally", make: () => ruleOf(makeIncrementalTally()) },
  { name: "heavy (json round-trip)", make: () => ruleOf(makeHeavyDetector()) },
];

interface Reading {
  name: string;
  median: number;
  min: number;
  max: number;
  spread: number;
  oracle: number;
}

/** The median of a non-empty list. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) {
    return sorted[mid] ?? 0;
  }
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function measureSample(sample: Sample): Reading {
  const corpus = buildDefaultCorpus();
  const timer = performanceTimer();
  const ratios: number[] = [];
  let oracle = 0;
  for (let i = 0; i < REPEATS; i++) {
    const result = calibrate(sample.make(), corpus, HARNESS_CONFIG, timer);
    ratios.push(result.codePerAnchor);
    oracle = result.oracleScore;
  }
  const min = Math.min(...ratios);
  const max = Math.max(...ratios);
  const mid = median(ratios);
  return { name: sample.name, median: mid, min, max, spread: (max - min) / mid, oracle };
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function padLeft(text: string, width: number): string {
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

console.log("\n M1 calibration check — measured C/A over a spread of rules");
console.log(` corpus: 1000 Events at peak density | ${REPEATS} repeats per rule`);
console.log(
  ` protocol: warmup ${HARNESS_CONFIG.warmupMs}ms, ${HARNESS_CONFIG.batches} x >=${HARNESS_CONFIG.batchMs}ms, median\n`,
);

const readings = samples.map(measureSample).sort((a, b) => a.median - b.median);

console.log(
  ` ${pad("rule", 24)} ${padLeft("C/A median", 12)} ${padLeft("min", 10)} ${padLeft("max", 10)} ${padLeft("spread", 8)}`,
);
console.log(
  ` ${"-".repeat(24)} ${"-".repeat(12)} ${"-".repeat(10)} ${"-".repeat(10)} ${"-".repeat(8)}`,
);
for (const reading of readings) {
  console.log(
    ` ${pad(reading.name, 24)} ${padLeft(reading.median.toFixed(4), 12)} ${padLeft(reading.min.toFixed(4), 10)} ${padLeft(reading.max.toFixed(4), 10)} ${padLeft(`${(reading.spread * 100).toFixed(1)}%`, 8)}`,
  );
}

const order = readings.map((r) => r.name.split(" ")[0]).join(" < ");
console.log(`\n ordering (slow -> fast): ${order}`);
console.log(` oracle O (health probe): ${(readings[0]?.oracle ?? 0).toFixed(3)} iters/ms\n`);
