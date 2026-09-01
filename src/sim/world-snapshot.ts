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
