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
 * The door-reader family's internal record, matching the `normalizedExample` in
 * `sensors.json`: a badge granted through a door at a site or the control center, and
 * the zone that door guards. Benign traffic is always a `grant` (the `deny` value is
 * for a later attack ticket). `ts` is in game seconds; `site` is the door's location
 * id (a site or the OCC), `zone` the guarded zone (e.g. `"z3"`).
 */
export interface DoorReaderReading {
  /** Game seconds. */
  ts: number;
  badge: string;
  site: string;
  door: string;
  zone: string;
  result: "grant";
}

/**
 * The door-contact family's internal record, matching the `normalizedExample` in
 * `sensors.json`: the magnetic sensor reporting a door opening or closing. Benign
 * traffic toggles `open`/`close`; the `forced`/`held` values are for a later attack
 * ticket. The engine's door reducer emits these, never a scheduler actor.
 */
export interface DoorContactReading {
  /** Game seconds. */
  ts: number;
  site: string;
  door: string;
  event: "open" | "close";
}

/**
 * The account-kiosk family's internal record, matching the `normalizedExample` in
 * `sensors.json`: an account signing in at a station's kiosk terminal. Benign traffic
 * is always a `success` (the `wrong_pin` value is for a later attack ticket, out of
 * scope here). This is a NEW type, distinct from the legacy `KioskReading` in
 * `endpoints/kiosk/internal.ts`, which the kiosk-pin-attack scenario keeps untouched.
 * `ts` is in game seconds; `terminal` is a deterministic per-kiosk id (e.g. `"K1"`).
 */
export interface AccountKioskReading {
  /** Game seconds. */
  ts: number;
  account: string;
  station: string;
  terminal: string;
  outcome: "success";
}

/**
 * The TVM (ticket vending machine) family's internal record, matching the
 * `normalizedExample` in `sensors.json`: a card topping up its stored value at a
 * station's machine. Benign traffic is always a `topup`. The live world rider emits
 * one when it tops up rather than going dormant on a low balance. `ts` is in game
 * seconds; `machine` is a deterministic per-machine id (e.g. `"V1"`); `amount` is a
 * whole-unit top-up.
 */
interface TvmReading {
  /** Game seconds. */
  ts: number;
  card: string;
  station: string;
  machine: string;
  amount: number;
  kind: "topup";
}

/**
 * The platform-camera family's internal record, matching the `normalizedExample` in
 * `sensors.json`: the camera over a station's fare gate turning a picture into two
 * numbers, how many taps (`grants`) and how many bodies (`persons`), counted over a
 * rolling window. Benign, so the two agree; an untapped person is the later Shadow
 * Rider hunt, out of scope here. The engine's camera reducer emits these, never a
 * scheduler actor. `ts` is in game seconds; `gate` is the gate id the reducer groups
 * by, derived from `station` via `gateIdForStation`.
 */
export interface CameraReading {
  /** Game seconds. */
  ts: number;
  station: string;
  gate: string;
  grants: number;
  persons: number;
}

/**
 * A discriminated reading tagged by its sensor id (distinct from a vendor
 * `Endpoint.id`). M0 had one arm; M2 adds the train-tracker arm; M3 adds the door
 * reader (a staff grant) and the door contact (the reducer's open/close); M4 adds the
 * tvm (a card top-up) and the kiosk (an account sign-in); M5 adds the platform camera
 * (the crowd reducer's per-gate counts). M6 adds the console and relay arms as their
 * actors land.
 */
export type WorldReading =
  | { sensor: "fare-gate"; reading: FareGateReading }
  | { sensor: "tvm"; reading: TvmReading }
  | { sensor: "kiosk"; reading: AccountKioskReading }
  | { sensor: "train-tracker"; reading: TrainReading }
  | { sensor: "door-reader"; reading: DoorReaderReading }
  | { sensor: "door-contact"; reading: DoorContactReading }
  | { sensor: "platform-camera"; reading: CameraReading };

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
