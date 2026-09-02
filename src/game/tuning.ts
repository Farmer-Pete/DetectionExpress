/**
 * Slice 0 tuning constants. One home so the sim, the sampler, and the visuals
 * all read the same numbers. Values are the exact ones from `1-PLAN.md`.
 */

/** Engine ticks per second while the tab is active. */
export const CLOCK_HZ = 60;

/** Snapshot publishes per second. CLOCK_HZ must divide by this. */
export const PUBLISH_HZ = 20;

/** The inspector's recent-events ring: how many Events it keeps, id-ordered. */
export const RING_SIZE = 256;

/**
 * The world-event ring's own capacity (GH124-PLAN.md Checkpoint 5), separate from
 * `RING_SIZE`: it logs every sensor's ambient traffic, not just the scored kiosk
 * stream, so it sees far higher volume (every fare-gate tap, camera count change,
 * door open/close, and console/relay tick) and needs more headroom before a row a
 * player might still want scrolls out.
 */
export const WORLD_LOG_RING_SIZE = 512;

/** Queue channel capacity. A push waits when the channel is full. */
export const CHANNEL_CAP = 100;

/** The Throughput gauge averages Sink completions over this window, in ms. */
export const THROUGHPUT_WINDOW_MS = 500;

/**
 * Slice 1 tuning constants (see `2-PLAN.md`). The sim, the scorer, and the
 * Scenario all read them here. Part 0's constants above stay until M2/M3 rewire
 * the pipeline; this milestone only adds.
 */

/** Ticks to game seconds. Sets the ~120x time compression (the Ingest schedule). */
export const GAME_SECONDS_PER_TICK = 2;

/** The deterministic level seed for data generation. */
export const LEVEL_SEED = 1337;

/** Outcomes kept in the rolling Correctness gauge. */
export const CORRECTNESS_WINDOW = 40;

/** A missed Attack weighs more in the score than a false Alert. */
export const CORRECTNESS_W_FN = 3;

/** A false Alert's weight in the score. */
export const CORRECTNESS_W_FP = 1;

/**
 * T10 (GH34-35-PLAN.md 1.7/2.2). The decision log's cap: `ScorerConfig.decisionsCap`,
 * mirroring the `liveHorizon` pattern. Oldest decisions drop past this count;
 * `reading()`'s lifetime counts are unaffected. Expected decision volume under a
 * normal run is roughly 14 caught plus occasional misses and false alarms, so this
 * will not normally trim mid-run.
 */
export const DECISIONS_CAP = 50;

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
export const CORPUS_VERSION = 2;
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

/**
 * Slice 2 "Keep up" — the squeeze (M2). The arrival rate rises in waves against a
 * fixed per-rule service rate. These constants set the wave ramp and the
 * checkpoints; the band test (M2 seam 9) locks them so the naive rule fails a
 * checkpoint with margin and the Optimization clears every one with margin.
 */

/**
 * The BENIGN baseline arrival rate per tick for each wave, low to high (its length
 * is the wave count). It bounds benign sign-ins started per tick, not the tick's
 * true event total: attack fails and benign fumbles ride ON TOP, so a tick's real
 * count can exceed the rate. The legacy stream already worked this way (attack
 * fails rode above the rate); GH102 only grows the magnitude. See ATTACKS_PER_WAVE.
 */
export const WAVE_RATES: readonly number[] = [5, 15, 60];

/** Number of waves. Derived from the rate schedule. */
export const WAVE_COUNT = WAVE_RATES.length;

/** The calm intro before Wave 1, in ticks (2 real seconds at CLOCK_HZ). */
export const INTRO_TICKS = 120;

/**
 * The length of each wave, in ticks. Much longer than the drain gap on purpose: a
 * rule that floods at the peak builds far more Queue than it can clear inside the
 * following gap, so it is still behind when the checkpoint reads it.
 */
export const WAVE_DURATION_TICKS = 240;

/**
 * The gap after each wave before its checkpoint, in ticks. Short on purpose: a
 * fast rule drains the whole wave inside it, but the naive scan cannot, so the two
 * separate at the checkpoint. Locked with the wave rates by the band test.
 *
 * #40 knob, constrained: `min(WAVE_WARN_TICKS, DRAIN_GAP_TICKS)` must stay `>=
 * CLOCK_HZ / PUBLISH_HZ` (the publish stride), or a successor wave's brief
 * 'incoming' phase can fall between publish samples, or vanish entirely, and
 * silently drop the flash/shake/announcement. Locked by `schedule.test.ts`'s
 * F012 case; see `wave-state.ts`'s precedence note.
 */
export const DRAIN_GAP_TICKS = 45;

/**
 * The Correctness hard-fail line. A checkpoint whose rolling Correctness reads
 * below this fails the run with reason "correctness".
 */
export const CORRECTNESS_FLOOR = 50;

/**
 * Wave juice (#38). First-draft numbers; #40's tuning pass revisits them once it
 * starts (see GH38+40-PLAN.md Part 3, gated on GH102 merging).
 */

/**
 * How many ticks before a wave's `startTick` the reading flips from "calm" to
 * "incoming" (`waveStateAt` in `wave-state.ts`). Roughly the prototype's warn
 * fraction of its cycle.
 *
 * #40 knob, constrained: for a successor wave's 'incoming' phase to be
 * observable at all, `min(WAVE_WARN_TICKS, DRAIN_GAP_TICKS)` must stay `>=
 * CLOCK_HZ / PUBLISH_HZ` (see `DRAIN_GAP_TICKS`'s note and `wave-state.ts`'s
 * precedence note). This constant is one half of that min() bound, so it must
 * clear the stride too, not just the gap.
 */
export const WAVE_WARN_TICKS = 30;

/**
 * The shared severity ramp's thresholds (`src/ui/hud/severity.ts`), promoted to
 * tuning constants so #40 can tune them. Generic names, not "queue"-specific:
 * the ramp also colors the Compute gauge.
 */
export const SEVERITY_WARN_FRAC = 0.5;
export const SEVERITY_DANGER_FRAC = 0.8;

/**
 * The live-hit count at which the findings panel throbs (`FindingsPanel.tsx`
 * gains the `urgent` border-pulse class at or above this count).
 */
export const URGENT_HITS = 3;

/**
 * The merged engine (GH117) advances the actor schedule ONE sim tick per game Clock
 * tick, so this multiplier is pinned at 1 (it once let the retired standalone world
 * loop step faster than the Clock; that step-accumulator model is gone — one Clock
 * now). Kept as a named factor, not inlined, so `FLASH_LIFE_TICKS` below still reads
 * as "1.1 wall seconds of sim ticks" rather than a bare `CLOCK_HZ` multiply.
 */
const SIM_TICKS_PER_CLOCK_TICK = 1;

/**
 * A sensor flash lives 1.1 sim seconds (87-VIEW-NOTES.md section 5), derived from the
 * clock rate so its ring expands and fades over its full life. The canvas fades over
 * this span.
 */
export const FLASH_LIFE_TICKS = Math.round(1.1 * CLOCK_HZ * SIM_TICKS_PER_CLOCK_TICK);

/**
 * How many recent sim ticks of flashes the world snapshot carries. A flash older than
 * this behind `nowTick` is pruned, so the flash list stays bounded on a perpetual run.
 * A few ticks beyond a full flash life, so the fractional render estimate can finish a
 * flash's fade before it is ever pruned.
 */
export const FLASH_WINDOW_TICKS = FLASH_LIFE_TICKS + 4;

/**
 * M1 (living metro, #87) rider population. The seeded spawner keeps a steady cast of
 * transient riders: it admits a fresh rider on each arrival tick while the live count
 * is below the target, so the population is bounded by the target and refills as
 * riders finish. These are first-draft numbers, tuned once M1 is on screen.
 */

/** The steady concurrent rider count the spawner aims for. The population never exceeds it. */
export const TARGET_RIDERS = 16;

/** The seeded inter-arrival gap between rider births, in whole ticks (min <= max, min >= 1). */
export const RIDER_ARRIVAL_MIN_TICKS = 3;
export const RIDER_ARRIVAL_MAX_TICKS = 12;

/** How long a fresh rider's active window runs, in ticks, before it heads home and exits. */
export const RIDER_WINDOW_TICKS = 600;

/**
 * A fresh rider's starting balance, in whole currency units, drawn per rider from the
 * spawner's seeded rng over `[RIDER_BALANCE_MIN, RIDER_BALANCE_MAX]`. A ride costs
 * `10 + 5 * minutes` (about 20 to 70), and a rider makes only about one trip per window
 * under the train-coupled wait, so a flat high balance never depletes and the TVM
 * top-up never shows. Instead the LOW end sits below the cheapest single fare (~20-35),
 * so a fraction of riders arrive unable to afford their first trip and top up at a TVM
 * on arrival (M4's visible "low rider refilling"), while the HIGH end lets most riders
 * ride their window without topping up. Whole units, so the balance and fares stay
 * integers; the high end stays below `TVM_TOPUP_AMOUNT + cheapest fare` only as a
 * matter of taste, not correctness (one top-up clears the dearest ~70 fare regardless).
 */
export const RIDER_BALANCE_MIN = 10;
export const RIDER_BALANCE_MAX = 200;

/**
 * M3 (living metro, #87) staff and doors. A seeded spawner keeps a small transient
 * staff cast: each walks from a location's nearest station to the location, crosses
 * its zones low to high tapping the door readers within its badge grade, then walks
 * back out. First-draft numbers, tuned once M3 is on screen.
 */

/** The steady concurrent staff count the spawner aims for (the prototype's cap of 3). */
export const STAFF_TARGET = 3;

/** The seeded inter-arrival gap between staff births, in whole ticks (min <= max, min >= 1). */
export const STAFF_ARRIVAL_MIN_TICKS = 30;
export const STAFF_ARRIVAL_MAX_TICKS = 90;

/**
 * GH116: a staff member's walk-in / walk-out duration couples to the straight-line
 * distance between its nearest station and its location (site or OCC), instead of a
 * flat tick count. `STAFF_WALK_SPEED` is design-units per tick; `STAFF_WALK_MIN_TICKS`
 * floors the result so even an adjacent pair still visibly walks. See
 * `staffWalkTicks` in `staff-spawner.ts`.
 */
export const STAFF_WALK_SPEED = 5;
export const STAFF_WALK_MIN_TICKS = 6;

/**
 * GH116: how long a live rider stands `at` its destination after tap-out before it
 * goes dormant for good (one trip, then home). The render alight step starts on the
 * next PUBLISHED snapshot, not the sim alight tick, and at 4x speed the publish
 * stride is up to 12 sim ticks (`CLOCK_HZ / PUBLISH_HZ * 4`). This dwell must outlast
 * `ALIGHT_TICKS` (12, in `ActorLayer.tsx`) PLUS that worst-case 12-tick publish
 * stride, so the alight animation has room to start and finish before the engine
 * evicts the rider, even at 4x. 25 clears 12 + 12 with one tick of standing margin.
 */
export const RIDER_GOHOME_DWELL_TICKS = 25;

/** Ticks between a staff member's consecutive door taps as it crosses the zones (> 0). */
export const STAFF_DOOR_STEP_TICKS = 8;

/** How many distinct badges the seeded staff pool mints; each staff draws one. */
export const STAFF_BADGE_POOL = 6;

/**
 * How long the engine holds a door open after a staff grant, in whole sim ticks,
 * before the door reducer closes it and emits the `door-contact` close. A positive
 * integer, comfortably shorter than a staff's per-door step so a door closes between taps.
 */
export const DOOR_DWELL_TICKS = 5;

/**
 * M2 (living metro, #87) train pacing. One persistent train rides each line, dwelling
 * at every platform and running the connection minutes between them (converted with
 * `minutesToTicks`). These set the derived, deterministic timetable.
 */

/**
 * The platform dwell, in whole sim ticks (~30 game seconds at `GAME_SECONDS_PER_TICK`).
 * A positive integer, so a train's reschedule off a dwell strictly advances its tick.
 */
export const TRAIN_DWELL_TICKS = 15;

/**
 * The service headway in game minutes. With one train per line it sets each line's
 * launch phase: line k's train first departs at `k * minutesToTicks(headway)`, so the
 * four trains do not leave their origins in lockstep.
 */
export const TRAIN_HEADWAY_MINUTES = 2;

/**
 * The service span in game minutes: the operating window the timetable's launch phases
 * wrap within, so a large headway can never push a line's first departure past the end
 * of service. The run itself is perpetual; this only bounds the derived launch phase.
 */
export const TRAIN_SERVICE_SPAN_MINUTES = 60;

/**
 * M4 (living metro, #87) station terminals: the kiosk and the TVM.
 *
 * The account-rider spawner keeps a small transient cast of account holders: each
 * walks to a station, signs in benignly at its kiosk, lingers, and leaves. The card
 * rider's TVM top-up refills a low balance so it can ride again. First-draft numbers,
 * tuned once M4 is on screen.
 */

/** The steady concurrent account-rider count the spawner aims for. */
export const ACCOUNT_RIDER_TARGET = 4;

/** The seeded inter-arrival gap between account-rider births, in whole ticks (min <= max, >= 1). */
export const ACCOUNT_ARRIVAL_MIN_TICKS = 12;
export const ACCOUNT_ARRIVAL_MAX_TICKS = 40;

/** Ticks an account rider lingers `at` the kiosk after signing in, before it despawns (> 0). */
export const ACCOUNT_DWELL_TICKS = 10;

/**
 * The whole-unit amount a low card rider tops up at a station TVM, chosen comfortably
 * above the most expensive single trip so one top-up always restores enough to ride
 * again. The `sensors.json` example tops up 100.
 */
export const TVM_TOPUP_AMOUNT = 100;

/**
 * M5 (living metro, #87) platform camera. The camera reducer counts fare-gate grants
 * per gate over this trailing window, in whole sim ticks, so a station's crowd-density
 * mark tracks its recent tap rate and decays as the taps age out. The reducer keeps
 * only this window's per-tick grant buckets, so its ring is bounded by
 * `CAMERA_WINDOW_TICKS * live gates` on a perpetual run. First-draft number, tuned
 * once M5 is on screen.
 */
export const CAMERA_WINDOW_TICKS = 60;

/**
 * M6 (living metro, #87) control center and network. One persistent operator sits at
 * each OCC console issuing benign commands, and one persistent host sits at each staff
 * site sending benign relays. These set their command / relay cadences and the small
 * launch phase that keeps the fixtures from firing in lockstep. First-draft numbers,
 * tuned once M6 is on screen.
 */

/** Whole ticks between an operator's benign commands (~60 game seconds). */
export const OPERATOR_COMMAND_TICKS = 30;

/** Whole ticks between a host's benign relays (~24 game seconds). */
export const HOST_RELAY_TICKS = 12;

/**
 * The per-index launch phase, in whole ticks, that staggers the operator and host
 * fixtures so they do not all fire on the same tick. Fixture k first acts at
 * `k * CONTROL_LAUNCH_PHASE_TICKS`.
 */
export const CONTROL_LAUNCH_PHASE_TICKS = 4;
