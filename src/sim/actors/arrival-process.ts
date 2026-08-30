/**
 * The shared seeded arrival process behind every population spawner (rider, staff,
 * account rider). Each spawner keeps a steady cast on a perpetual run: on each tick it
 * admits a fresh actor whenever the live count is below a target and an arrival is due,
 * then advances the next arrival by a seeded inter-arrival gap.
 *
 * The three spawners differ only in what they mint (the `admit` factory), their id
 * prefix, and their arrival-gap tuning. This owns the one behaviour they share: the
 * `while (nextArrival <= nowTick)` admission loop, the target cap, and the seeded gap.
 *
 * DETERMINISM CONTRACT. The caller passes the same seeded `rng` its `admit` factory
 * draws from. Within one loop iteration the order of draws is exactly: every draw
 * `admit` makes (when admitting), then the single `drawGap` draw — unchanged from when
 * each spawner inlined this loop. `nextArrival` starts at 0 so the cast fills from the
 * first tick, and each gap is `minGap + floor(rng() * (maxGap - minGap + 1))`. That draw
 * order and count per tick is the replay contract (ARCHITECTURE rule 8, ADR-0007); do
 * not reorder the `admit`/`drawGap` calls.
 */

/** What a seeded arrival process needs: its gap tuning, its rng, its cap, its factory. */
export interface ArrivalProcessConfig<A> {
  /** Inclusive minimum inter-arrival gap in whole ticks (min >= 1, min <= max). */
  minGap: number;
  /** Inclusive maximum inter-arrival gap in whole ticks. */
  maxGap: number;
  /** The seeded stream the process draws gaps from; the SAME stream `admit` draws from. */
  rng: () => number;
  /** The steady concurrent cap. The process never admits above it. */
  target: number;
  /** Mints one admission due at `atTick`, drawing from the shared `rng`. */
  admit: (atTick: number) => A;
}

/** A seeded arrival source the engine ticks once per sim tick. */
export interface ArrivalProcess<A> {
  /**
   * The admissions due at `nowTick` given the current live count. Zero or more, bounded
   * so `live + result.length <= target`. Deterministic for the seed and the sequence of
   * `(nowTick, live)` inputs.
   */
  tick(nowTick: number, live: number): A[];
}

/**
 * Build a seeded, target-capped arrival process. Preserves the exact per-tick draw
 * order every spawner had inline: admit (its draws) then one gap draw, per iteration.
 */
export function seededArrivalProcess<A>(config: ArrivalProcessConfig<A>): ArrivalProcess<A> {
  const gapSpan = config.maxGap - config.minGap + 1;
  const drawGap = (): number => config.minGap + Math.floor(config.rng() * gapSpan);

  // The next tick an arrival is considered. Starts at 0 so the cast fills from the first
  // tick, then advances by a seeded gap after each arrival.
  let nextArrival = 0;

  return {
    tick: (nowTick, live) => {
      const admissions: A[] = [];
      while (nextArrival <= nowTick) {
        if (live + admissions.length < config.target) {
          admissions.push(config.admit(nowTick));
        }
        // Advance past this arrival whether or not it was filled, so a full cast drops
        // the arrival rather than backing up unboundedly.
        nextArrival += drawGap();
      }
      return admissions;
    },
  };
}
