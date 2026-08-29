/**
 * M1 validation harness (human checkpoint, not a CI gate). It times a spread of
 * sample rules over the real profiler and prints each rule's measured C/A and its
 * stability across repeats. A poor rule must measure slow, a good rule fast, with
 * a stable ordering. The absolute numbers vary run to run; that is expected. See
 * GH3-PLAN.md section 13.
 *
 * Run: `pnpm run m1:check`.
 */

import { calibrate, type ProfilerRule } from "../src/game/profiler/calibrate";
import type { MeasureConfig } from "../src/game/profiler/measure";
import { buildDefaultCorpus, performanceTimer } from "../src/game/profiler/profile";
import {
  type Detector,
  type MatchView,
  makeIncrementalTally,
  makeNaiveScan,
  type NormalizedKiosk,
  normalizeKiosk,
  SCAN_WINDOW_S,
} from "../src/game/profiler/rules";
import type { Finding } from "../src/sim/finding";

/** A lighter protocol than production, so the harness finishes in a few seconds. */
const HARNESS_CONFIG: MeasureConfig = { warmupMs: 40, batchMs: 40, batches: 3 };
const REPEATS = 5;
const THRESHOLD = 5;

/** Wrap a detector as the rule the calibrator prices. */
function ruleOf(detector: Detector): ProfilerRule<NormalizedKiosk> {
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
    step(event: MatchView): Finding[] {
      if (event.outcome !== "fail") {
        return [];
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
        return [];
      }
      if (firing.has(event.account)) {
        return [];
      }
      firing.add(event.account);
      return [{ alert: { reason: "pin_brute_force", at: event.ts, eventIds: [event.id] } }];
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
    step(event: MatchView): Finding[] {
      if (event.outcome !== "fail") {
        return [];
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
        return [];
      }
      if (firing.has(event.account)) {
        return [];
      }
      firing.add(event.account);
      return [{ alert: { reason: "pin_brute_force", at: event.ts, eventIds: [event.id] } }];
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
    step(event: MatchView): Finding[] {
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
  make: () => ProfilerRule<NormalizedKiosk>;
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

// The gate: the measured C/A must order by algorithmic cost (a low reading is
// slow), and each rule's spread across repeats must stay stable. A violation
// exits non-zero so this can run as a check, not just a print. The absolute
// numbers move machine to machine; the ordering and the spread bound do not.
const MAX_SPREAD = 0.75; // a reading whose min..max spans more than this is unstable
const byKey = new Map(readings.map((r) => [r.name.split(" ")[0], r]));
const violations: string[] = [];

/** Assert `slower` measured a lower C/A than `faster`, or record the violation. */
function expectSlower(slower: string, faster: string): void {
  const lo = byKey.get(slower)?.median ?? 0;
  const hi = byKey.get(faster)?.median ?? 0;
  if (!(lo < hi)) {
    violations.push(
      `ordering: ${slower} (${lo.toFixed(4)}) must measure slower than ${faster} (${hi.toFixed(4)})`,
    );
  }
}

// The robust chain: the poor O(n^2) rule is slowest, the heavy (naive + JSON)
// rule sits below the plain naive scan, and both O(1) rules (the tally and the
// bucket) measure faster than the naive scan. The bucket and the tally are both
// O(1) and close, so their relative order is NOT asserted — it flips run to run.
expectSlower("poor", "heavy");
expectSlower("heavy", "naive");
expectSlower("naive", "incremental");
expectSlower("naive", "per-account");

for (const reading of readings) {
  if (reading.spread > MAX_SPREAD) {
    violations.push(
      `stability: ${reading.name} spread ${(reading.spread * 100).toFixed(1)}% exceeds ${(MAX_SPREAD * 100).toFixed(0)}%`,
    );
  }
}

if (violations.length > 0) {
  console.error(" FAIL: the measured calibration broke its invariants:");
  for (const violation of violations) {
    console.error(`   - ${violation}`);
  }
  process.exit(1);
}
console.log(" PASS: ordering and stability hold.\n");
