/**
 * Slice 0 tuning constants. One home so the sim, the sampler, and the visuals
 * all read the same numbers. Values are the exact ones from `1-PLAN.md`.
 */

/** Engine ticks per second while the tab is active. */
export const CLOCK_HZ = 60;

/** Snapshot publishes per second. CLOCK_HZ must divide by this. */
export const PUBLISH_HZ = 20;

/** Backlog channel capacity. A push waits when the channel is full. */
export const CHANNEL_CAP = 100;

/** EMA time constant in seconds. */
export const RATE_TAU = 0.4;

/** Input occupancy above this ramps a node's heat. */
export const OCC_THRESHOLD = 0.5;

/** Seconds of sustained fill to reach full red. */
export const HEAT_RAMP_S = 2.5;

/** Seconds to cool from red back to calm. */
export const HEAT_COOL_S = 2.0;

/** Heat above this strobes the belt and blinks the node. */
export const HEAT_STROBE = 0.6;

/** The Throughput gauge averages Sink completions over this window, in ms. */
export const THROUGHPUT_WINDOW_MS = 500;

/**
 * Slice 1 tuning constants (see `2-PLAN.md`). The sim, the scorer, and the
 * Scenario all read them here. Part 0's constants above stay until M2/M3 rewire
 * the pipeline; this milestone only adds.
 */

/** Ticks to game seconds. Sets the ~120x time compression (the Ingest schedule). */
export const GAME_SECONDS_PER_TICK = 2;

/** Wrong PINs within the window that flag a PIN brute-force Attack. */
export const PIN_BRUTE_FORCE_THRESHOLD = 5;

/** The PIN brute-force detection window, in game seconds (5 minutes). */
export const PIN_BRUTE_FORCE_WINDOW_S = 300;

/** The deterministic level seed for data generation. */
export const LEVEL_SEED = 1337;

/** Outcomes kept in the rolling Correctness gauge. */
export const CORRECTNESS_WINDOW = 40;

/** A missed Attack weighs more in the score than a false Alert. */
export const CORRECTNESS_W_FN = 3;

/** A false Alert's weight in the score. */
export const CORRECTNESS_W_FP = 1;

/**
 * Slice 2 "Keep up" tuning constants (see `GH3-PLAN.md`, section 8). M1 needs the
 * measurement-engine set: the corpus size and density, the profiler's batch and
 * median protocol, the service-rate quantization denominator, the difficulty dial
 * Omega, and the detection window the naive scan evicts past. The squeeze (M2) and
 * the Optimization (M3) add the wave schedule and the governor on top of these.
 */

/**
 * The fixed denominator for the quantized rational service rate (records per
 * tick = num/den). A large power-friendly denominator keeps the rounding error
 * below one part per million before the fraction is reduced by its gcd.
 */
export const SERVICE_DEN = 1_000_000;

/** Events in the calibration corpus the profiler times the player's code over. */
export const CORPUS_SIZE = 1000;

/**
 * The corpus density, in Events per tick, at a representative peak wave. It is a
 * parameter, not the final peak: the true peak couples to the M2 wave schedule,
 * so the corpus fixes a representative worst case for the naive scan and leaves
 * the exact value to the band test. Denser windows make the naive filter scan
 * longer arrays, which is the worst-case (lowest) throughput we want to price.
 */
export const CORPUS_PEAK_EVENTS_PER_TICK = 20;

/** The minimum wall time a profiler batch runs before it is measured, in ms. */
export const PROFILE_BATCH_MS = 50;

/** Batches per measure. The median of these is the reading, to reject an outlier. */
export const PROFILE_BATCHES = 5;

/**
 * The warm-up the profiler runs and discards before it times a batch, in ms. A
 * cold JIT measures slow, so the first stretch is thrown away (see section 11's
 * JIT-warmth note).
 */
export const PROFILE_WARMUP_MS = 50;

/**
 * Cache-key components (GH3-PLAN.md 5.1). A calibration reading is only reused
 * when the corpus and the profiler protocol that produced it are unchanged, so
 * these versions are folded into the key. Bump one when its shape changes, so a
 * stale reading is not reused.
 */
export const CORPUS_VERSION = 1;
export const PROFILER_VERSION = 1;

/**
 * The difficulty dial, in anchor-units per tick. `serviceRate = (C/A) * OMEGA`,
 * so a larger Omega gives every rule a higher records-per-tick rate. The naive
 * default rule measures at roughly one anchor-unit (C/A ~ 1), so its rate lands
 * near OMEGA: between the Wave 2 (15) and Wave 3 (60) arrival, so it keeps up
 * through Wave 2 and drowns at the peak. The Optimization measures many
 * anchor-units, so its rate clears the peak. Locked by the band test (M2 seam 9).
 */
export const OMEGA = 20;

/**
 * Accounts the calibration corpus spreads its traffic over, mirrored by the
 * band test's cost model. Kept here so the winnability test and the corpus agree
 * on the window-fill the naive scan pays at peak density.
 */
export const CORPUS_ACCOUNTS = 12;

/** Share of corpus Events that are wrong-PIN failures, the ones the detectors scan. */
export const CORPUS_FAIL_SHARE = 0.5;

/** The detection window in ticks (300 game seconds). The naive scan evicts past it. */
export const SCAN_WINDOW_TICKS = PIN_BRUTE_FORCE_WINDOW_S / GAME_SECONDS_PER_TICK;

/**
 * Slice 2 "Keep up" — the squeeze (M2). The arrival rate rises in waves against a
 * fixed per-rule service rate. These constants set the wave ramp and the
 * checkpoints; the band test (M2 seam 9) locks them so the naive rule fails a
 * checkpoint with margin and the Optimization clears every one with margin.
 */

/** Events per tick for each wave, low to high. Its length is the wave count. */
export const WAVE_RATES: readonly number[] = [5, 15, 60];

/** Number of waves. Derived from the rate schedule. */
export const WAVE_COUNT = WAVE_RATES.length;

/** The calm intro before Wave 1, in ticks (2 real seconds at CLOCK_HZ). */
export const INTRO_TICKS = 120;

/**
 * The length of each wave, in ticks. Much longer than the drain gap on purpose: a
 * rule that floods at the peak builds far more Backlog than it can clear inside the
 * following gap, so it is still behind when the checkpoint reads it.
 */
export const WAVE_DURATION_TICKS = 240;

/**
 * The gap after each wave before its checkpoint, in ticks. Short on purpose: a
 * fast rule drains the whole wave inside it, but the naive scan cannot, so the two
 * separate at the checkpoint. Locked with the wave rates by the band test.
 */
export const DRAIN_GAP_TICKS = 45;

/**
 * The Correctness hard-fail line. A checkpoint whose rolling Correctness reads
 * below this fails the run with reason "correctness".
 */
export const CORRECTNESS_FLOOR = 50;
