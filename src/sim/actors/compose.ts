/**
 * The GeneratedRun composer (issue #89). It turns actor readings
 * into sorted, id-assigned events. Generic over the reading type, so any future
 * actor slots in without a new composer. This ticket injects no Attack, so it
 * always returns `attacks: []`; the run builder attaches the checkpoints.
 */
import type { PipeEvent } from "../event";

export interface ComposeInput<Reading> {
  readonly readings: readonly Reading[];
  /** Reads the reading's scheduled time, in game seconds. */
  tsOf: (reading: Reading) => number;
  /** The endpoint's wire formatter. */
  format: (reading: Reading) => unknown;
  readonly endpointId: string;
}

export interface ComposedRun {
  events: PipeEvent[];
  attacks: [];
}

/**
 * Sort readings by `(ts, emission order)`, format each into an event, and assign
 * ids `0..n-1` from the sorted index. The emission-order tiebreak matches the
 * kiosk scenario: a stable sort on the reading's position in the input array.
 */
export function composeRun<Reading>(input: ComposeInput<Reading>): ComposedRun {
  const { readings, tsOf, format, endpointId } = input;
  const ordered = readings
    .map((reading, seq) => ({ reading, seq, ts: tsOf(reading) }))
    .sort((a, b) => a.ts - b.ts || a.seq - b.seq);

  const events: PipeEvent[] = ordered.map((entry, id) => ({
    id,
    ts: entry.ts,
    endpoint: endpointId,
    payload: format(entry.reading),
  }));

  return { events, attacks: [] };
}
