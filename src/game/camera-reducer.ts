/**
 * The camera reducer: an engine projection over the frozen world, NOT a scheduler
 * actor, mirroring `door-reducer.ts`. The scheduler gives an actor only immutable
 * env, its rng, and its tick, and ADR-0007 freezes the env, so a platform camera
 * that counts the riders who tapped a gate cannot be an actor. Instead the engine
 * folds each tick's fare-gate grant readings through this reducer after all
 * transitions: it groups them by gate and keeps a bounded ring of per-tick grant
 * buckets over a rolling window, so it can report the tap rate at each gate without
 * remembering the whole run.
 *
 * Benign, so `persons === grants`: the camera sees exactly the riders who tapped (an
 * untapped person is the later Shadow Rider hunt, out of scope). The reducer is
 * order-independent and deterministic: it groups a tick's grants by gate before
 * counting, sums the window, and sorts the per-gate output by gate id, so the counts
 * do not depend on the order the grants arrived in. It reads no wall clock
 * (ARCHITECTURE rule 8) and holds only the window, so its ring stays bounded on a
 * perpetual run: a bucket older than the window is pruned the moment it ages out.
 */

/** A fare-gate grant the camera counts, keyed by its station and derived gate id. */
export interface CameraGrant {
  station: string;
  gate: string;
}

/** The windowed body/tap count at one gate the reducer produces each tick. */
interface CameraCount {
  station: string;
  gate: string;
  grants: number;
  persons: number;
}

/** The stateful camera projection the engine steps once per tick. */
export interface CameraReducer {
  /**
   * Fold one tick's fare-gate grants into the rolling window at `tick`: prune the
   * buckets older than the window, add this tick's grants as one per-gate bucket, and
   * return the windowed grants/persons per gate, sorted by gate. Benign, so
   * `persons === grants`. A gate with no grant left inside the window is omitted.
   */
  step(grants: readonly CameraGrant[], tick: number): CameraCount[];
}

/** One tick's grant count at one gate, the unit the window ring is built from. */
interface Bucket {
  station: string;
  gate: string;
  tick: number;
  grants: number;
}

export function createCameraReducer(windowTicks: number): CameraReducer {
  // The rolling ring: one bucket per (gate, tick) that saw grants, pruned the moment
  // it ages past the window, so the ring never exceeds windowTicks * live gates.
  let buckets: Bucket[] = [];

  return {
    step: (grants, tick) => {
      // 1. Prune buckets older than the window, so the ring stays bounded.
      buckets = buckets.filter((bucket) => tick - bucket.tick < windowTicks);

      // 2. Group this tick's grants by gate and add one bucket per gate. Grouping
      //    before counting makes the result independent of the grants' arrival order.
      const perGate = new Map<string, { station: string; grants: number }>();
      for (const grant of grants) {
        const current = perGate.get(grant.gate);
        if (current === undefined) {
          perGate.set(grant.gate, { station: grant.station, grants: 1 });
        } else {
          current.grants += 1;
        }
      }
      for (const [gate, { station, grants: count }] of perGate) {
        buckets.push({ station, gate, tick, grants: count });
      }

      // 3. Sum the window per gate. Benign, so persons mirrors grants exactly.
      const totals = new Map<string, CameraCount>();
      for (const bucket of buckets) {
        const current = totals.get(bucket.gate);
        if (current === undefined) {
          totals.set(bucket.gate, {
            station: bucket.station,
            gate: bucket.gate,
            grants: bucket.grants,
            persons: bucket.grants,
          });
        } else {
          current.grants += bucket.grants;
          current.persons += bucket.grants;
        }
      }

      // 4. Sort by gate id, so the emitted counts are deterministic across ticks.
      return [...totals.values()].sort((a, b) => a.gate.localeCompare(b.gate));
    },
  };
}
