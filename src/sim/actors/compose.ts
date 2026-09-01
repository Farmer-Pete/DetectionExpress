/**
 * The GeneratedRun composer (issue #89, extended by GH102). It turns actor
 * readings into sorted, id-assigned events. Generic over the reading type, so any
 * actor slots in without a new composer.
 *
 * The composer never knows what an Attack is. It carries ground truth only as an
 * opaque label: an optional `attackIdOf` maps a reading to an attack id (or null
 * for benign), and the composer buckets the resulting event ids per attack in
 * sorted order. The scenario turns those id buckets into `Attack` records; the
 * corpus omits the callback and gets an empty map. `endpointIdOf` is read per
 * reading so a future mixed-endpoint stream needs no new composer.
 */
import type { PipeEvent } from "../event";

/**
 * How to turn one reading into a wire event, minus its id: its scheduled time, its
 * endpoint, and its payload. Shared by the batch composer and the live scored-ingress
 * adapter (GH117-PLAN.md "Part C"), so a live-emitted event is byte-identical to the
 * precomposed one the scorer's Attack evidence binds to. Parity guard 1 depends on it.
 */
export interface EventShape<Reading> {
  /** Reads the reading's scheduled time, in game seconds. */
  tsOf: (reading: Reading) => number;
  /** The endpoint's wire formatter. */
  format: (reading: Reading) => unknown;
  /** Per-reading endpoint id; return a constant for a single-endpoint run. */
  endpointIdOf: (reading: Reading) => string;
}

/** Build one wire event for a reading at a chosen id. The one place a PipeEvent is minted. */
export function composeEvent<Reading>(
  reading: Reading,
  id: number,
  shape: EventShape<Reading>,
): PipeEvent {
  return {
    id,
    ts: shape.tsOf(reading),
    endpoint: shape.endpointIdOf(reading),
    payload: shape.format(reading),
  };
}

export interface ComposeInput<Reading> extends EventShape<Reading> {
  readonly readings: readonly Reading[];
  /** Optional ground-truth label. Return null for a benign reading. */
  attackIdOf?: (reading: Reading) => number | null;
}

export interface ComposedRun {
  events: PipeEvent[];
  /** Post-sort event ids per attack id, ids ascending. Empty when attackIdOf is omitted. */
  eventIdsByAttack: Map<number, number[]>;
}

/**
 * Sort readings by `(ts, emission order)`, format each into an event, and assign
 * ids `0..n-1` from the sorted index. The emission-order tiebreak matches the
 * kiosk scenario: a stable sort on the reading's position in the input array. When
 * `attackIdOf` is supplied, each labeled reading's sorted id is appended to its
 * attack's bucket; because ids are assigned in sorted order, every bucket comes out
 * ascending by construction.
 */
export function composeRun<Reading>(input: ComposeInput<Reading>): ComposedRun {
  const { readings, tsOf, format, endpointIdOf, attackIdOf } = input;
  const ordered = readings
    .map((reading, seq) => ({ reading, seq, ts: tsOf(reading) }))
    .sort((a, b) => a.ts - b.ts || a.seq - b.seq);

  const events: PipeEvent[] = [];
  const eventIdsByAttack = new Map<number, number[]>();
  ordered.forEach((entry, id) => {
    events.push(composeEvent(entry.reading, id, { tsOf, format, endpointIdOf }));
    if (attackIdOf !== undefined) {
      const attackId = attackIdOf(entry.reading);
      if (attackId !== null) {
        const bucket = eventIdsByAttack.get(attackId);
        if (bucket === undefined) {
          eventIdsByAttack.set(attackId, [id]);
        } else {
          bucket.push(id);
        }
      }
    }
  });

  return { events, eventIdsByAttack };
}
