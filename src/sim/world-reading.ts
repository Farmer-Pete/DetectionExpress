/**
 * The one reading and environment contract for the metro's mixed cast. `Actor` is
 * already generic, so the live schedule chooses these concrete type parameters
 * rather than changing the interface: every live actor is
 * `Actor<WorldReading, WorldEnv>`.
 *
 * `WorldReading` and `WorldEnv` GROW per milestone: each variant and each env field
 * lands only with the milestone that emits or reads it, so Knip never sees an
 * unused arm or an unread field. M0 defines only what exists today: the fare-gate
 * reading and the `{ world, distances }` env.
 */
import type { FareGateReading } from "./endpoints/fare-gate/gatekeep";
import type { DistanceTable } from "./world/distance";
import type { Timetable } from "./world/timetable";
import type { World } from "./world/world";

/**
 * The train-tracker family's internal record, matching the `normalizedExample` in
 * `sensors.json`: a train arriving at (`arr`) or leaving (`dep`) a station, and on
 * which track. `ts` is in game seconds; `track` is a deterministic per-segment id.
 */
interface TrainReading {
  /** Game seconds. */
  ts: number;
  train: string;
  line: string;
  station: string;
  event: "arr" | "dep";
  track: string;
}

/**
 * A discriminated reading tagged by its sensor id (distinct from a vendor
 * `Endpoint.id`). M0 had one arm; M2 adds the train-tracker arm. M3..M6 add tvm,
 * kiosk, door, camera, console, and relay arms as their actors land.
 */
export type WorldReading =
  | { sensor: "fare-gate"; reading: FareGateReading }
  | { sensor: "train-tracker"; reading: TrainReading };

/** The read-only environment every live actor reads. It grows per milestone. */
export interface WorldEnv {
  world: World;
  distances: DistanceTable;
  /** The derived train timetable. M2 adds it; riders ignore it, the train rides it. */
  timetable: Timetable;
  // M6 adds:  consoles: readonly Console[];  destinations: readonly string[];
}

/**
 * The engine's unified per-tick log entry. Every reading, whatever produced it, is
 * wrapped into this one type so a reducer always knows which tick a reading came
 * from. The source order is fixed each tick — actor readings first, then the door
 * reducer, then the camera reducer — so the combined stream is deterministic. M0
 * only produces `"actor"` entries; the reducer sources land in M3 and M5.
 */
export interface TimedWorldReading {
  reading: WorldReading;
  tick: number;
  source: "actor" | "door" | "camera";
  /** Set for source `"actor"`: the actor that emitted the reading. */
  actorId?: string;
}
