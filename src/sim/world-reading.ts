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
import type { World } from "./world/world";

/**
 * A discriminated reading tagged by its sensor id (distinct from a vendor
 * `Endpoint.id`). M0 has one arm; M2..M6 add tvm, kiosk, door, camera, train,
 * console, and relay arms as their actors land.
 */
export type WorldReading = { sensor: "fare-gate"; reading: FareGateReading };

/** The read-only environment every live actor reads. It grows per milestone. */
export interface WorldEnv {
  world: World;
  distances: DistanceTable;
  // M2 adds:  timetable: Timetable;
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
