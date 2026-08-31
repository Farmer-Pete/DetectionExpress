/**
 * mergeRuns: the composable-streams merge seam (GH42-PLAN.md "Composable streams:
 * the merge seam"). It turns several already-generated runs into the one
 * `GeneratedRun` the run controller plays: many Scenarios, thrown at the engine at
 * once, scored by one Correctness instance.
 *
 * `buildSchedule()` is seedless, so every Scenario's run already carries the
 * identical wave schedule and checkpoints (`sim/schedule.ts`). Concatenating two
 * copies of that schedule would trip `assertNoOverlap` (`wave-schedule.ts`), since
 * both start at the same first tick (`INTRO_TICKS`). So this asserts every run's
 * `waves` and `checkpoints` are equal and keeps exactly one copy: mixing runs
 * means running them against one shared rising-pressure timeline, not two laid
 * end to end.
 *
 * Events merge and renumber in time order, ties broken by run index then the
 * event's own (already time-ordered) id, so the result is fully deterministic.
 * Every Attack's `id` is renumbered too, since two runs independently number
 * their own Attacks from 1 and would otherwise collide, and its `eventIds` remap
 * through that same run's id map.
 *
 * `PipeEvent.payload` is `unknown`, so this cannot rewrite entities generically to
 * make them disjoint after the fact. Entity disjointness must already be set at
 * generation, through a scenario's own partition seam (see the pin-brute-force
 * scenario's `partition` parameter); this only asserts it held.
 */
import type { Attack } from "./attack";
import type { PipeEvent } from "./event";
import type { Checkpoint, GeneratedRun, Wave } from "./scenario";

/** True when two wave arrays describe the identical schedule, field for field. */
function wavesEqual(a: readonly Wave[], b: readonly Wave[]): boolean {
  return (
    a.length === b.length &&
    a.every((wave, i) => {
      const other = b[i];
      return (
        other !== undefined &&
        wave.startTick === other.startTick &&
        wave.durationTicks === other.durationTicks &&
        wave.eventsPerTick === other.eventsPerTick
      );
    })
  );
}

/** True when two checkpoint arrays describe the identical schedule, field for field. */
function checkpointsEqual(a: readonly Checkpoint[], b: readonly Checkpoint[]): boolean {
  return (
    a.length === b.length &&
    a.every((cp, i) => {
      const other = b[i];
      return (
        other !== undefined &&
        cp.atTick === other.atTick &&
        cp.clearsThroughWave === other.clearsThroughWave
      );
    })
  );
}

/**
 * Reject a set of runs whose wave schedules are not all identical. Prevents the
 * only failure mode a "shared timeline" merge cannot recover from silently: a
 * mismatched schedule would either desync the runs' relative timing or, if
 * concatenated instead, collide on `INTRO_TICKS` and trip `assertNoOverlap`.
 */
function assertSchedulesEqual(runs: readonly GeneratedRun[]): void {
  const first = runs[0];
  if (first === undefined) {
    return;
  }
  runs.forEach((run, index) => {
    if (index === 0) {
      return;
    }
    if (
      !wavesEqual(run.waves, first.waves) ||
      !checkpointsEqual(run.checkpoints, first.checkpoints)
    ) {
      throw new Error(
        `mergeRuns: run ${index} carries a different wave schedule than run 0. buildSchedule() ` +
          "is seedless, so every merged run must share the identical waves and checkpoints; " +
          "mergeRuns keeps one shared copy rather than concatenating them, which would trip " +
          "wave-schedule.ts's assertNoOverlap (both schedules start at the same first tick).",
      );
    }
  });
}

/** One source event, tagged with the run it came from, for a stable global sort. */
interface TaggedEvent {
  runIndex: number;
  event: PipeEvent;
}

/**
 * Merge every run's events into one time-ordered stream with fresh ids `0..n-1`,
 * and return the per-run map from each run's own old event id to its new one, so
 * `remapAttacks` can translate `Attack.eventIds` through it. The sort key is
 * `(ts, runIndex, old id)`: `old id` alone already reflects each run's own time
 * order (every Scenario's `composeRun` assigns ids in sorted-time order), so this
 * tiebreak is fully deterministic without reading run-specific emission order.
 */
function mergeEvents(runs: readonly GeneratedRun[]): {
  events: PipeEvent[];
  idMaps: Map<number, number>[];
} {
  const tagged: TaggedEvent[] = runs.flatMap((run, runIndex) =>
    run.events.map((event): TaggedEvent => ({ runIndex, event })),
  );
  tagged.sort(
    (a, b) => a.event.ts - b.event.ts || a.runIndex - b.runIndex || a.event.id - b.event.id,
  );

  const idMaps: Map<number, number>[] = runs.map(() => new Map<number, number>());
  const events: PipeEvent[] = tagged.map((entry, newId) => {
    const idMap = idMaps[entry.runIndex];
    if (idMap === undefined) {
      throw new Error(`mergeRuns: no id map allocated for run ${entry.runIndex}.`);
    }
    idMap.set(entry.event.id, newId);
    return {
      id: newId,
      ts: entry.event.ts,
      endpoint: entry.event.endpoint,
      payload: entry.event.payload,
    };
  });
  return { events, idMaps };
}

/**
 * Remap every run's Attacks onto the merged numbering: a fresh, globally unique
 * `id` (each run numbers its own Attacks independently, typically both from 1,
 * so the raw ids would collide), and `eventIds` translated through that run's own
 * id map. An `eventIds` entry with no mapping means the Attack cites evidence
 * that is not among its own run's events — a generation bug this merge refuses
 * to paper over, since it would silently break that run's own separability.
 */
function remapAttacks(
  runs: readonly GeneratedRun[],
  idMaps: readonly Map<number, number>[],
): Attack[] {
  let nextId = 1;
  const merged: Attack[] = [];
  runs.forEach((run, runIndex) => {
    const idMap = idMaps[runIndex];
    if (idMap === undefined) {
      throw new Error(`mergeRuns: no id map allocated for run ${runIndex}.`);
    }
    for (const attack of run.attacks) {
      const eventIds = attack.eventIds.map((oldId) => {
        const newId = idMap.get(oldId);
        if (newId === undefined) {
          throw new Error(
            `mergeRuns: run ${runIndex}'s Attack ${attack.id} cites event id ${oldId}, which is ` +
              "not among that run's own events. Each run's Attacks may only cite evidence from " +
              "its own stream, or the merge cannot preserve that run's own separability.",
          );
        }
        return newId;
      });
      merged.push({ ...attack, id: nextId, eventIds });
      nextId += 1;
    }
  });
  return merged;
}

/**
 * Reject two Attacks, from the same or different runs, that end up owning the
 * same merged event id. A real Scenario's own separability proof already rules
 * this out within one run; this is the merge's own guard against a remap bug (or
 * a malformed run) silently letting two Attacks share one piece of evidence,
 * which would let one Finding double-credit both.
 */
function assertNoEventIdCollision(attacks: readonly Attack[]): void {
  const owner = new Map<number, number>(); // merged event id -> the Attack id that owns it
  for (const attack of attacks) {
    for (const eventId of attack.eventIds) {
      const existing = owner.get(eventId);
      if (existing !== undefined && existing !== attack.id) {
        throw new Error(
          `mergeRuns: merged event id ${eventId} is cited by two different Attacks (${existing} and ` +
            `${attack.id}). A merge must never let two Attacks claim the same merged event id.`,
        );
      }
      owner.set(eventId, attack.id);
    }
  }
}

/**
 * Reject two runs whose Attacks share an entity. `PipeEvent.payload` is
 * `unknown`, so mergeRuns cannot rewrite entities into disjointness after the
 * fact: a scenario's own generation-time partition seam (e.g. pin-brute-force's
 * `partition` parameter) must already guarantee it. This only asserts that it
 * held, so a partitioning bug fails loudly here instead of silently
 * cross-crediting one account's evidence between two unrelated Attacks.
 */
function assertEntitiesDisjoint(runs: readonly GeneratedRun[]): void {
  const claimedBy = new Map<string, number>(); // entity -> the run index that first attacked it
  runs.forEach((run, runIndex) => {
    for (const attack of run.attacks) {
      const owner = claimedBy.get(attack.entity);
      if (owner !== undefined && owner !== runIndex) {
        throw new Error(
          `mergeRuns: entity "${attack.entity}" is attacked in both run ${owner} and run ${runIndex}. ` +
            "Merged runs must draw disjoint entities at generation (see the pin-brute-force scenario's " +
            "partition parameter), or a Finding on that entity could credit the wrong run's Attack.",
        );
      }
      claimedBy.set(attack.entity, runIndex);
    }
  });
}

/**
 * Reject a remap that changed any Attack's evidence count, or one that is not a
 * true bijection on evidence ids: an array-length match alone cannot catch a
 * remap bug that maps two distinct source ids onto the same merged id, because
 * `remapAttacks` maps `eventIds` element-wise, so the array length is always
 * preserved even when a collision silently collapses two ids into one. This
 * checks the DISTINCT id count survives instead, which a collision or a
 * duplicate cannot pass. Each source run already proved its own separability
 * before merging (every Attack carries at least its threshold of evidence, and
 * only that Attack's own account crosses it); the merge's only job is to
 * preserve that proof exactly, never to drop, duplicate, or collapse evidence
 * while renumbering ids.
 */
function assertSeparabilityPreserved(
  originals: readonly Attack[],
  merged: readonly Attack[],
): void {
  if (originals.length !== merged.length) {
    throw new Error(
      `mergeRuns: expected ${originals.length} merged Attacks, got ${merged.length}.`,
    );
  }
  originals.forEach((original, i) => {
    const remapped = merged[i];
    if (remapped === undefined || remapped.eventIds.length !== original.eventIds.length) {
      throw new Error(
        `mergeRuns: Attack ${original.id}'s evidence count changed during remap (` +
          `${original.eventIds.length} -> ${remapped?.eventIds.length ?? "missing"}). Each run already ` +
          "proved its own separability before merging; the merge must preserve it exactly.",
      );
    }
    const originalDistinct = new Set(original.eventIds).size;
    const remappedDistinct = new Set(remapped.eventIds).size;
    if (originalDistinct !== original.eventIds.length || remappedDistinct !== originalDistinct) {
      throw new Error(
        `mergeRuns: Attack ${original.id}'s remap is not a bijection on evidence ids ` +
          `(${originalDistinct} distinct source ids, ${original.eventIds.length} total; ` +
          `${remappedDistinct} distinct merged ids). Each of an Attack's own event ids must be ` +
          "distinct, and the remap must carry that uniqueness through one-to-one.",
      );
    }
  });
}

/**
 * Merge several already-generated runs into one, playing them concurrently
 * against the one shared wave timeline they all carry. See the module doc for
 * the shape of the merge and the three invariants it asserts.
 */
export function mergeRuns(runs: GeneratedRun[]): GeneratedRun {
  const first = runs[0];
  if (first === undefined) {
    throw new Error("mergeRuns: needs at least one run.");
  }
  assertSchedulesEqual(runs);
  const { events, idMaps } = mergeEvents(runs);
  const attacks = remapAttacks(runs, idMaps);
  assertNoEventIdCollision(attacks);
  assertEntitiesDisjoint(runs);
  assertSeparabilityPreserved(
    runs.flatMap((run) => run.attacks),
    attacks,
  );
  return { events, attacks, checkpoints: first.checkpoints, waves: first.waves };
}
