/**
 * WorldSnapshot: the one immutable reading the world sampler publishes to the world
 * store each publish tick. It mirrors `snapshot.ts` for the metro view. React reads
 * it through per-field selectors; it never sees the world half-updated.
 *
 * The snapshot carries semantic presence, not pixels: the engine owns the
 * authoritative `ActorView` map (seeded from registration, updated by presence
 * deltas, pruned on dormancy), and the view owns the layout.
 */
import type { MapNodeId, Presence } from "./world/presence";
import type { TimedWorldReading } from "./world-reading";

/** One live actor the map draws, with its semantic presence. */
export interface ActorView {
  id: string;
  kind: "rider" | "account-rider" | "train" | "staff" | "operator" | "host" | "pin-attacker";
  presence: Presence;
  /**
   * Which run this actor belongs to (GH117-PLAN.md "Part D"): `"scored-scenario"` for
   * the scenario cast whose kiosk readings the scorer reads, `"ambient"` for the metro's
   * ambient life. The merged engine tags every actor so the next step can enforce the
   * scoring boundary (only scored-scenario kiosk readings are admitted). Optional: the
   * legacy world engine never sets it, and it is drawn by `kind`, not by provenance.
   */
  provenance?: "scored-scenario" | "ambient";
}

/**
 * A short, fading mark the view draws at a node when a sensor fires. `pinfail` is a
 * wrong-PIN kiosk fail (GH117), distinct from the door-reader `deny` it sits next to:
 * the two belong to different sensor families, and reusing `deny` would blur a kiosk
 * fail with a door-badge fail.
 */
export interface FlashEvent {
  id: number;
  kind:
    | "tap"
    | "topup"
    | "signin"
    | "grant"
    | "deny"
    | "door"
    | "command"
    | "packet"
    | "train"
    | "pinfail";
  node: MapNodeId;
  atTick: number;
}

export interface WorldSnapshot {
  /** UI-only fractional render estimate. The sim never reads it. */
  nowTick: number;
  actors: readonly ActorView[];
  /** Door projection (reducer output). Empty until M3 lands the door reducer. */
  doors: readonly { node: MapNodeId; open: boolean }[];
  /** Camera reducer output. Empty until M5 lands the camera reducer. */
  crowds: readonly { node: MapNodeId; persons: number; grants: number }[];
  /** Recent flashes, within a short window of `nowTick`. */
  flashes: readonly FlashEvent[];
  /**
   * Recent normalized readings for the event-log panel, newest first and bounded. A
   * flash carries only a node and a kind, so the log needs the payload separately;
   * this feeds the "sensor, place, detail" rows the view shows.
   */
  log: readonly TimedWorldReading[];
  counts: { riders: number; trains: number; staff: number };
}

/** The reading before the first sample: an empty, quiet world. */
export function emptyWorldSnapshot(): WorldSnapshot {
  return {
    nowTick: 0,
    actors: [],
    doors: [],
    crowds: [],
    flashes: [],
    log: [],
    counts: { riders: 0, trains: 0, staff: 0 },
  };
}
