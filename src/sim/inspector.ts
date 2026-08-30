/**
 * The Inspector: a bounded ring of recent Events, raw and normalized, plus a
 * processed watermark. The Normalize and Detect tasks write to it through the
 * write-only `TaskInspector` slice; the sampler reads a fresh `snapshot()` each
 * publish tick. The inspector needs no ground truth, so `engine.ts` builds it
 * directly, unlike the scorer, which the run controller injects.
 */
import type { JsonValue } from "./finding";

/** One recent Event, raw and normalized, id-ordered. */
export interface RingEvent {
  id: number;
  ts: number;
  endpoint: string;
  /** Payload as it entered Normalize. `null` when it would not serialize. */
  raw: JsonValue;
  /** Payload Normalize produced. `null` when it would not serialize. */
  normalized: JsonValue;
}

/** The write surface the tasks hold. */
export interface TaskInspector {
  /**
   * Ring in one Event's raw and normalized payload, id-ordered, evicting the
   * oldest past `ringSize`. Never throws: a form that will not JSON-round-trip
   * (a circular reference, a BigInt) stores a `null` placeholder for that form
   * alone, so the entry is kept and id continuity holds.
   */
  captureNormalized(
    id: number,
    ts: number,
    endpoint: string,
    raw: unknown,
    normalized: unknown,
  ): void;
  /**
   * Advance the processed watermark by one. A COUNT, not an id: event.id >= processed
   * is exact only because ids are 0-based dense (scenario.ts) and Detect scores in
   * strict FIFO id order. See `snapshot.ts` for the full invariant.
   */
  markProcessed(): void;
}

/** The full inspector: the write surface plus the sampler's read. */
export interface Inspector extends TaskInspector {
  /** A fresh frozen events array and the watermark count. Never aliases the ring. */
  snapshot(): { events: readonly RingEvent[]; processed: number };
}

/** JSON-round-trip a value; a circular reference or BigInt falls back to `null`. */
function toJsonSafe(value: unknown): JsonValue {
  try {
    const parsed: JsonValue = JSON.parse(JSON.stringify(value));
    return parsed;
  } catch {
    return null;
  }
}

export function createInspector(config: { ringSize: number }): Inspector {
  const ring: RingEvent[] = [];
  let processed = 0;

  return {
    captureNormalized(id, ts, endpoint, raw, normalized) {
      ring.push({
        id,
        ts,
        endpoint,
        raw: toJsonSafe(raw),
        normalized: toJsonSafe(normalized),
      });
      if (ring.length > config.ringSize) {
        ring.shift();
      }
    },
    markProcessed() {
      processed += 1;
    },
    snapshot() {
      return { events: Object.freeze([...ring]), processed };
    },
  };
}
