/**
 * The world-event ring: a bounded, id-ordered log of every sensor reading the
 * living metro produces, published on `SimSnapshot.worldEvents`. It mirrors
 * `inspector.ts`'s ring shape (bounded, deep-frozen at push, oldest evicted past
 * capacity) but is a wholly separate structure: its own id namespace
 * (`WorldLogEvent.id`, never a scored pipeline id), its own capacity
 * (`WORLD_LOG_RING_SIZE`, not `RING_SIZE`), and a wider domain — every sensor kind,
 * not just the scored kiosk stream. It feeds the unified log panel and every place
 * dialog's scoped view (the same ring, filtered by `placeId`), never the scorer.
 *
 * `scored`/`scoredEventId` mark the subset of entries that ALSO crossed the #117
 * scoring boundary (a kiosk reading off a scored-scenario actor): those two ids are
 * separate namespaces on the same entry, so a consumer can always tell whether a
 * row has a pipeline event to open beside its raw reading.
 */

import type { SensorCode } from "./world/layout";
import type { MapNodeId } from "./world/presence";
import type { WorldReading } from "./world-reading";

/** The canonical sensor id every `WorldReading` carries. */
export type SensorKind = WorldReading["sensor"];

/** One entry in the world-event ring: a raw sensor reading, located and timed,
 *  plus whether it crossed the scoring boundary. */
export interface WorldLogEvent {
  /** The ring's own dense id, in push order. A separate namespace from a scored
   *  pipeline event id — never conflate the two. */
  id: number;
  /** Game seconds. */
  ts: number;
  sensor: SensorKind;
  /** The station, site, or OCC id the log links to and the place dialog selects. */
  placeId: MapNodeId;
  /**
   * The sensor chip node the map should flash, when this sensor has one.
   * Train-tracker rows omit it: a T chip exists only at a depot or a signal
   * cabin, so a train reading keys off `placeId` (the station) alone.
   */
  chipNode?: MapNodeId;
  /** The actor that emitted it, when one did. Door-contact and platform-camera
   *  are engine reducer projections, not actor readings, so they omit it. */
  actorId?: string;
  /** The reading itself, exactly as the sensor emitted it. */
  reading: WorldReading;
  /** True only for a kiosk reading off a scored-scenario actor (the #117 boundary). */
  scored: boolean;
  /** The scored pipeline event id this entry's reading became, when `scored`. */
  scoredEventId?: number;
}

/** One `WorldLogEvent`'s fields the ring assigns `id` for; the caller supplies the rest. */
export type WorldLogEntry = Omit<WorldLogEvent, "id">;

/** The exhaustive canonical-name -> single-letter `SensorCode` map (`world/layout.ts`'s
 *  chip codes). Every `WorldReading` arm names exactly one map chip, so this is total. */
const CODE_BY_SENSOR: Record<SensorKind, SensorCode> = {
  kiosk: "K",
  "fare-gate": "G",
  tvm: "V",
  "platform-camera": "C",
  "door-reader": "R",
  "door-contact": "D",
  "train-tracker": "T",
  "network-relay": "N",
  "occ-console": "O",
};

/** A sensor's canonical `WorldReading["sensor"]` name to its map-chip `SensorCode`. */
export function sensorCodeFor(sensor: SensorKind): SensorCode {
  return CODE_BY_SENSOR[sensor];
}

/** The inverse of `CODE_BY_SENSOR`. Written out, not derived: `world-log.test.ts`
 *  round-trips every entry both ways, so the two tables cannot silently drift apart
 *  without a failing test, and this stays free of a runtime `Object.fromEntries` cast. */
const SENSOR_BY_CODE: Record<SensorCode, SensorKind> = {
  K: "kiosk",
  G: "fare-gate",
  V: "tvm",
  C: "platform-camera",
  R: "door-reader",
  D: "door-contact",
  T: "train-tracker",
  N: "network-relay",
  O: "occ-console",
};

/** A map-chip `SensorCode` to its canonical `WorldReading["sensor"]` name. */
export function sensorKindForCode(code: SensorCode): SensorKind {
  return SENSOR_BY_CODE[code];
}

/** Recursively freeze a value in place. Only objects and arrays descend. */
function freezeDeep<T>(value: T): T {
  if (value instanceof Object) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      freezeDeep(child);
    }
  }
  return value;
}

/** The write surface plus the sampler's read, mirroring `inspector.ts`'s `Inspector`. */
export interface WorldLog {
  /** Ring in one entry, assigning the next dense id, evicting the oldest past
   *  capacity. Never throws: the caller (the engine's capture sites) is itself
   *  wrapped non-throwing, but this stays defensive on its own. */
  push(entry: WorldLogEntry): void;
  /** A fresh frozen array of every entry currently in the ring, oldest first. */
  snapshot(): readonly WorldLogEvent[];
}

export function createWorldLog(capacity: number): WorldLog {
  const ring: WorldLogEvent[] = [];
  let nextId = 0;

  return {
    push(entry) {
      ring.push(freezeDeep({ id: nextId++, ...entry }));
      if (ring.length > capacity) {
        ring.shift();
      }
    },
    snapshot() {
      return Object.freeze([...ring]);
    },
  };
}
