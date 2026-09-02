/**
 * The place dialog's view model (GH124-PLAN.md Checkpoint 4): pure functions that turn
 * a `MapSelection` into what `PlaceDialog.tsx` renders. Kept separate from the
 * component so the mapping from world data + a live snapshot to devices, actors, and
 * descriptive text is unit-tested without mounting React.
 *
 * `describePresence` and `actorsAtNode` take only `(presence, snapshot)` /
 * `(nodeId, snapshot)` — no `World` — so their text is built from ids and the actor
 * graph alone, never a station's display name; `placeView` (which does receive
 * `World`) is the one place real names surface, sourced from `metroNodes(world)`, not
 * hardcoded.
 */
import type { MapSelection } from "../../game/store";
import type { SimSnapshot } from "../../sim/snapshot";
import { type MapNode, metroNodes, type SensorCode } from "../../sim/world/layout";
import type { MapNodeId, Presence } from "../../sim/world/presence";
import type { World } from "../../sim/world/world";
import type { ActorView } from "../../sim/world-snapshot";
import type { PlaceKind } from "../icons/sensor-icons";

export type { MapSelection } from "../../game/store";

/** One header badge: a label/value pair, e.g. `{ label: "Zone", value: "Z3" }`. */
export interface MetaBadge {
  label: string;
  value: string;
}

/** One device card: a sensor chip's code, human name, an optional technical detail,
 *  and its access state (derived from the node it sits on, see `devicesForNode`). */
export interface DeviceView {
  code: SensorCode;
  name: string;
  detail?: string;
  state: string;
}

/** One actor row: what draws it on the map (`glyphKind`), its id, a human role label,
 *  and its current activity (`doing`/`heading`, from `describePresence`). */
export interface ActorLine {
  glyphKind: ActorView["kind"];
  id: string;
  role: string;
  doing: string;
  heading: string;
}

/** The whole dialog's content for one selection. The scoped log field arrives in
 *  Checkpoint 5 (GH124-PLAN.md); this shape intentionally carries none yet. */
export interface PlaceView {
  title: string;
  iconKind: PlaceKind | undefined;
  meta: readonly MetaBadge[];
  devices: readonly DeviceView[];
  actors: readonly ActorLine[];
}

/** A human sensor name per chip code, for the device card title. */
const SENSOR_NAME: Record<SensorCode, string> = {
  K: "Account kiosk",
  G: "Fare gate",
  V: "Ticket machine",
  C: "Platform camera",
  R: "Door reader",
  D: "Door contact",
  T: "Train tracker",
  N: "Network relay",
  O: "Control console",
};

/** A human label per actor kind, for the actor row's role column. */
const ROLE_LABEL: Record<ActorView["kind"], string> = {
  rider: "Rider",
  "account-rider": "Account rider",
  train: "Train",
  staff: "Staff",
  operator: "Operator",
  host: "Host",
  "pin-attacker": "Pin attacker",
};

/** A human label per site `type` (`world.ts`'s `SITE_TYPES`). */
const SITE_TYPE_LABEL: Record<string, string> = {
  depot: "Depot",
  "signal-cabin": "Signal cabin",
  substation: "Substation",
};

/**
 * Where a train's OWN presence (never `onTrain`; see `trainPlacement`'s doc) currently
 * puts it: the edge it rides, or the node it dwells at. Null only if a future Presence
 * arm is added and not yet handled here.
 */
function trainDestination(presence: Presence): MapNodeId | null {
  if (presence.kind === "moving") {
    return presence.to;
  }
  if (presence.kind === "at") {
    return presence.node;
  }
  return null;
}

/**
 * What a presence is doing right now, and a short description of where it is headed.
 * Exhaustive over `Presence`'s three arms. The `onTrain` arm alone carries only a
 * train id and ticks, so its destination is resolved by looking up that train's own
 * `ActorView` in the snapshot; if the train is not (yet) in the snapshot, it degrades
 * to naming the train instead of a destination.
 */
export function describePresence(
  presence: Presence,
  snapshot: SimSnapshot,
): { doing: string; heading: string } {
  switch (presence.kind) {
    case "at":
      return {
        doing: presence.untilTick === "open" ? "stationed" : "waiting",
        heading: `at ${presence.node}`,
      };
    case "moving":
      return { doing: "walking", heading: `to ${presence.to}` };
    case "onTrain": {
      const train = snapshot.actors.find((actor) => actor.id === presence.train);
      const destination = train === undefined ? null : trainDestination(train.presence);
      return {
        doing: "riding",
        heading: destination === null ? `on ${presence.train}` : `to ${destination}`,
      };
    }
  }
}

/**
 * The device cards for one node: one per sensor chip `metroNodes(world)` places there,
 * in chip order. `state` is the node's access class — `"public"` for a station's four
 * passenger-facing sensors, `"restricted"` for a site or the OCC's staff-only ones —
 * derived from the node itself, not live sim state (this function takes no snapshot).
 * An unknown node id returns an empty list rather than throwing, since a stale
 * selection should render an empty dialog, not crash it.
 */
export function devicesForNode(nodeId: MapNodeId, world: World): DeviceView[] {
  const node = metroNodes(world).find((candidate) => candidate.id === nodeId);
  if (node === undefined) {
    return [];
  }
  const state = node.kind === "station" ? "public" : "restricted";
  return node.chips.map((chip) => ({
    code: chip.code,
    name: SENSOR_NAME[chip.code],
    detail: chip.sensor,
    state,
  }));
}

/**
 * The actors whose presence resolves to `nodeId`: an actor sitting `at` that node, or
 * — when `nodeId` names a train's actor id instead of a place — a rider `onTrain` on
 * it. The two id spaces (`MapNodeId` and a train's actor id) never collide, so one
 * query serves both a station/site/OCC dialog and a train dialog's onboard-rider list.
 */
export function actorsAtNode(nodeId: MapNodeId, snapshot: SimSnapshot): ActorLine[] {
  const lines: ActorLine[] = [];
  for (const actor of snapshot.actors) {
    const presence = actor.presence;
    const resolvesHere =
      (presence.kind === "at" && presence.node === nodeId) ||
      (presence.kind === "onTrain" && presence.train === nodeId);
    if (!resolvesHere) {
      continue;
    }
    const { doing, heading } = describePresence(presence, snapshot);
    lines.push({
      glyphKind: actor.kind,
      id: actor.id,
      role: ROLE_LABEL[actor.kind],
      doing,
      heading,
    });
  }
  return lines;
}

/** A site's `type`, narrowed to `PlaceKind`'s three site arms. A real type guard, not
 *  a cast: `world.ts`'s `parseSite` already validates `type` against `SITE_TYPES`
 *  (the same three strings), so this narrowing always succeeds for a live site — it
 *  just proves that to `tsc` without asserting past it. */
function isSitePlaceKind(type: string): type is "depot" | "signal-cabin" | "substation" {
  return type === "depot" || type === "signal-cabin" || type === "substation";
}

/** A site or the OCC's place kind for `placeIcon` (`sensor-icons.tsx`); undefined for
 *  a station, which has no place icon of its own. */
function placeKindForNode(node: MapNode, world: World): PlaceKind | undefined {
  if (node.kind === "occ") {
    return "control-center";
  }
  if (node.kind === "site") {
    const site = world.sites.find((candidate) => candidate.id === node.id);
    return site !== undefined && isSitePlaceKind(site.type) ? site.type : undefined;
  }
  return undefined;
}

/** A station's meta badges: one "Line" badge per line it serves. */
function stationMeta(node: MapNode, world: World): MetaBadge[] {
  const station = world.stations.find((candidate) => candidate.id === node.id);
  if (station === undefined) {
    return [];
  }
  return station.lines.map((lineId) => ({
    label: "Line",
    value: world.lines.find((line) => line.id === lineId)?.name ?? lineId,
  }));
}

/** A site or the OCC's meta badges: its dominant zone, then its type. */
function placeMeta(node: MapNode, world: World): MetaBadge[] {
  const badges: MetaBadge[] = [{ label: "Zone", value: `Z${node.zone ?? 0}` }];
  if (node.kind === "site") {
    const site = world.sites.find((candidate) => candidate.id === node.id);
    if (site !== undefined) {
      badges.push({ label: "Type", value: SITE_TYPE_LABEL[site.type] ?? site.type });
    }
  } else {
    badges.push({ label: "Type", value: "Control center" });
  }
  return badges;
}

/**
 * The whole dialog's content for one `MapSelection`. A train selection carries its
 * onboard riders and no devices (a train has none); a node selection carries its real
 * `world.json` name and type, its devices, and the actors currently at it.
 */
export function placeView(selection: MapSelection, snapshot: SimSnapshot, world: World): PlaceView {
  if (selection.kind === "train") {
    return {
      title: `Train ${selection.actorId}`,
      iconKind: undefined,
      meta: [],
      devices: [],
      actors: actorsAtNode(selection.actorId, snapshot),
    };
  }
  const node = metroNodes(world).find((candidate) => candidate.id === selection.id);
  if (node === undefined) {
    // Defensive only: every node id the map can select is a fixed world.json fixture
    // (see the store's mapSelection doc), so this should be unreachable in practice.
    return { title: selection.id, iconKind: undefined, meta: [], devices: [], actors: [] };
  }
  return {
    title: node.name,
    iconKind: placeKindForNode(node, world),
    meta: node.kind === "station" ? stationMeta(node, world) : placeMeta(node, world),
    devices: devicesForNode(node.id, world),
    actors: actorsAtNode(node.id, snapshot),
  };
}
