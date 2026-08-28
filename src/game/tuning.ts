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

/** Share of accounts that see an Attack. */
export const THREAT_RATE = 0.15;

/** Timeline length, in game minutes. */
export const SCENARIO_MINUTES = 30;

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
 * The difficulty dial, in anchor-units per tick. `serviceRate = (C/A) * OMEGA`,
 * so a larger Omega gives every rule a higher records-per-tick rate. This is a
 * placeholder: M2's band test tunes it so the naive rate sits between Wave 2 and
 * Wave 3 arrival and the Optimization sits above the peak.
 */
export const OMEGA = 1;

/** The detection window in ticks (300 game seconds). The naive scan evicts past it. */
export const SCAN_WINDOW_TICKS = PIN_BRUTE_FORCE_WINDOW_S / GAME_SECONDS_PER_TICK;
