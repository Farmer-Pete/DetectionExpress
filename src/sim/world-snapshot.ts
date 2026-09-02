/**
 * `ActorView` and `FlashEvent`: the two map-drawing types the merged engine publishes
 * as part of `SimSnapshot` (`snapshot.ts`). The snapshot carries semantic presence,
 * not pixels: the engine owns the authoritative `ActorView` map (seeded from
 * registration, updated by presence deltas, pruned on dormancy), and the view owns
 * the layout.
 */
import type { MapNodeId, Presence } from "./world/presence";

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
  /**
   * The station this actor is currently trying to reach (GH124-PLAN.md Checkpoint 4
   * Part 2), for the place dialog's "heading to X" wording. View-only, like
   * `presence`: it never affects scoring, the world-event ring, or the #117 parity
   * guards. Populated only for a `rider` that has
   * actually committed to a destination right now — `world-rider.ts` sets it once its
   * trip core picks one and clears it once the trip ends. `account-rider` never sets
   * it: it only visits a kiosk and leaves, with no metro destination of its own.
   * Every other kind (`train`, `staff`, `operator`, `host`, `pin-attacker`) never sets
   * it either. Undefined for a waiting rider with no chosen destination yet, or for
   * one whose trip has already ended.
   */
  destination?: MapNodeId;
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

/** One open door the map draws, projected from `door-reducer.ts`'s open-door state. */
export interface DoorView {
  node: MapNodeId;
  open: boolean;
}

/** One node's crowd density the map draws, projected from `camera-reducer.ts`'s counts. */
export interface CrowdView {
  node: MapNodeId;
  persons: number;
  grants: number;
}
