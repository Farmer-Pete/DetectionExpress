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
