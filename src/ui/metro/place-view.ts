/**
 * The place dialog's view model (GH124-PLAN.md Checkpoint 4): pure functions that turn
 * a `MapSelection` into what `PlaceDialog.tsx` renders. Kept separate from the
 * component so the mapping from world data + a live snapshot to devices, actors, and
 * descriptive text is unit-tested without mounting React.
 *
 * All the mapping functions take `World` so real `world.json` display names surface
 * everywhere — `describePresence` renders "heading to Central" / "heading to Market"
 * rather than raw node ids, and `placeView` titles/badges use the same names —
 * sourced from `metroNodes(world)`, never hardcoded.
 *
 * The ACTORS section is a compact, aggregated table, not a per-actor list (individual
 * actor ids are not useful to a player): `actorsAtNode` still returns one line per
 * actor (the aggregation's input and its own test seam), but `actorSummaryRows`
 * groups those lines by (kind, activity) and counts each group — see its doc for the
 * sort order and the pin-attacker threat tone.
 */
import type { MapSelection } from "../../game/store";
import type { SimSnapshot } from "../../sim/snapshot";
import { type MapNode, metroNodes, type SensorCode } from "../../sim/world/layout";
import type { MapNodeId, Presence } from "../../sim/world/presence";
import type { World } from "../../sim/world/world";
import type { WorldLogEvent } from "../../sim/world-log";
import type { ActorView } from "../../sim/world-snapshot";
import type { PlaceKind } from "../icons/sensor-icons";

export type { MapSelection } from "../../game/store";

/** One header badge: a label/value pair, e.g. `{ label: "Zone", value: "Z3" }`. */
interface MetaBadge {
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
 *  and its current activity (a single phrase from `describePresence`, e.g. "heading
 *  to Riverside" or "waiting for a train"). The aggregation input, and its own test
 *  seam — `actorSummaryRows` groups these, but never renders them one-for-one. */
export interface ActorLine {
  glyphKind: ActorView["kind"];
  id: string;
  role: string;
  activity: string;
}

/**
 * One row of the ACTORS table (GH124-PLAN.md Checkpoint 4 Part 4): every actor
 * sharing `kind` and `activity` collapses into one counted row, since individual
 * actor ids are not useful to a player and a station can easily hold a dozen riders.
 * `tone: "threat"` marks a pin-attacker row for the dialog's threat coloring.
 */
export interface ActorSummaryRow {
  kind: ActorView["kind"];
  activity: string;
  count: number;
  tone?: "threat";
}

/** The whole dialog's content for one selection. */
export interface PlaceView {
  title: string;
  iconKind: PlaceKind | undefined;
  meta: readonly MetaBadge[];
  devices: readonly DeviceView[];
  /** The ACTORS table's rows: `actorSummaryRows` for this same selection. */
  actorRows: readonly ActorSummaryRow[];
  /**
   * The world-event ring entries scoped to this selection, newest first
   * (GH124-PLAN.md Checkpoint 5): the SAME `snapshot.worldEvents` ring the unified
   * log panel reads, filtered here rather than held in a second buffer.
   */
  log: readonly WorldLogEvent[];
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

/** A human label per actor kind, for the ACTORS table's Actor column. */
export const ROLE_LABEL: Record<ActorView["kind"], string> = {
  rider: "Rider",
  "account-rider": "Account rider",
  train: "Train",
  staff: "Staff",
  operator: "Operator",
  host: "Host",
  // Generic category, not the specific scenario: the scenario ("Pin attacking")
  // lives in the Activity column, so a new attack scenario reuses this actor and
  // icon rather than adding a new kind. See `activityFor`.
  "pin-attacker": "Attacker",
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

/** A node id's human display name from `world.json` (e.g. `cen` -> `Central`), falling
 *  back to the raw id if it names nothing on the map. */
function nodeLabel(id: MapNodeId, world: World): string {
  return metroNodes(world).find((node) => node.id === id)?.name ?? id;
}

/**
 * A single-phrase description of what a presence is doing right now. Exhaustive over
 * `Presence`'s three arms:
 *
 * - `at`: `destination` is the FEASIBILITY answer's plumbed field (GH124-PLAN.md
 *   Checkpoint 4 Part 1/2) — a `rider` that has
 *   committed to a trip carries it (set by `world-rider.ts` the moment its trip core
 *   picks a destination, cleared once the trip ends), so a waiting rider that HAS
 *   already chosen where it is going reads "heading to X" instead of a bare "waiting".
 *   Undefined `destination` reads "waiting for a train": either no trip is chosen
 *   yet (a rider still planning, or between trips), or the caller never resolves one
 *   for a kind that has no such concept (a non-trip actor's "on duty" wording is
 *   decided by the caller, `actorsAtNode`, not here — this function has no actor kind
 *   to branch on).
 * - `moving`: always "heading to X", the edge's own `to` node — true regardless of
 *   kind, since a `moving` presence always carries a real near-term target.
 * - `onTrain`: the rider carries only a train id and ticks, so its destination is
 *   resolved by looking up that train's own `ActorView` in the snapshot; if the train
 *   is not (yet) in the snapshot, it degrades to naming the train instead.
 */
export function describePresence(
  presence: Presence,
  snapshot: SimSnapshot,
  world: World,
  destination?: MapNodeId,
): string {
  switch (presence.kind) {
    case "at":
      return destination === undefined
        ? "waiting for a train"
        : `heading to ${nodeLabel(destination, world)}`;
    case "moving":
      return `heading to ${nodeLabel(presence.to, world)}`;
    case "onTrain": {
      const train = snapshot.actors.find((actor) => actor.id === presence.train);
      const trainDest = train === undefined ? null : trainDestination(train.presence);
      return trainDest === null
        ? `riding on ${presence.train}`
        : `heading to ${nodeLabel(trainDest, world)}`;
    }
  }
}

/** Only `rider` ever populates `ActorView.destination` (the FEASIBILITY answer,
 *  GH124-PLAN.md Checkpoint 4 Part 1). An account rider only visits a kiosk and
 *  leaves; it takes no metro trip and carries no destination, so it is NOT a trip
 *  kind and must not fall through to the "waiting for a train" wording. */
function isTripKind(kind: ActorView["kind"]): boolean {
  return kind === "rider";
}

/**
 * One actor's activity phrase for the table. A non-trip actor `at` a node does not
 * route through `describePresence`, whose "at" wording is a trip actor's fallback and
 * has no meaning for a fixture, a patron at a kiosk, or an attacker mid-attack. The
 * Actor column holds the generic kind and the Activity column holds what it is doing,
 * so an `account-rider` reads "signing in at a kiosk", a `pin-attacker` reads "Pin
 * attacking" (the scenario, so a new attack reuses the Attacker actor), and staff,
 * operators, hosts, and a dwelling train read "on duty". Every other presence shape
 * (`moving`, `onTrain`, or an "at" trip rider) routes straight through
 * `describePresence`, destination included.
 */
function activityFor(actor: ActorView, snapshot: SimSnapshot, world: World): string {
  if (actor.presence.kind === "at" && !isTripKind(actor.kind)) {
    if (actor.kind === "account-rider") {
      return "signing in at a kiosk";
    }
    if (actor.kind === "pin-attacker") {
      return "Pin attacking";
    }
    return "on duty";
  }
  return describePresence(actor.presence, snapshot, world, actor.destination);
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
export function actorsAtNode(nodeId: MapNodeId, snapshot: SimSnapshot, world: World): ActorLine[] {
  const lines: ActorLine[] = [];
  for (const actor of snapshot.actors) {
    const presence = actor.presence;
    // In steady mode the engine pre-seeds every future patron `at` its station at
    // tick 0 (fromTick === untilTick === its future startTick), so an `at` presence
    // only counts as present once its window has opened: fromTick <= now. A genuinely
    // waiting or dwelling actor passes this; a not-yet-arrived one does not.
    const resolvesHere =
      (presence.kind === "at" &&
        presence.node === nodeId &&
        presence.fromTick <= snapshot.nowTick) ||
      (presence.kind === "onTrain" && presence.train === nodeId);
    if (!resolvesHere) {
      continue;
    }
    lines.push({
      glyphKind: actor.kind,
      id: actor.id,
      role: ROLE_LABEL[actor.kind],
      activity: activityFor(actor, snapshot, world),
    });
  }
  return lines;
}

/** The `nodeId` a selection resolves to for `actorsAtNode`: the node itself, or a
 *  train's own actor id (`actorsAtNode`'s doc explains why the two id spaces never
 *  collide). Shared by `actorSummaryRows` and `placeView` so they scope identically. */
function actorNodeId(selection: MapSelection): MapNodeId {
  return selection.kind === "train" ? selection.actorId : selection.id;
}

/**
 * The ACTORS table's rows for one selection (GH124-PLAN.md Checkpoint 4 Part 4):
 * `actorsAtNode`'s per-actor lines, grouped by (kind, activity) and counted, since a
 * player has no use for individual actor ids and a busy station can hold a dozen
 * riders doing the same two or three things. Sorted threats first (a pin-attacker
 * group always sorts above everything else, `tone: "threat"`), then by count
 * descending, then by activity text for a stable order between equal counts.
 */
export function actorSummaryRows(
  selection: MapSelection,
  snapshot: SimSnapshot,
  world: World,
): ActorSummaryRow[] {
  const lines = actorsAtNode(actorNodeId(selection), snapshot, world);
  const rowByKey = new Map<string, ActorSummaryRow>();
  for (const line of lines) {
    const key = `${line.glyphKind} ${line.activity}`;
    const existing = rowByKey.get(key);
    if (existing !== undefined) {
      existing.count += 1;
      continue;
    }
    rowByKey.set(key, {
      kind: line.glyphKind,
      activity: line.activity,
      count: 1,
      ...(line.glyphKind === "pin-attacker" ? { tone: "threat" as const } : {}),
    });
  }
  return [...rowByKey.values()].sort((a, b) => {
    const threatRank = (row: ActorSummaryRow) => (row.tone === "threat" ? 0 : 1);
    const byThreat = threatRank(a) - threatRank(b);
    if (byThreat !== 0) {
      return byThreat;
    }
    const byCount = b.count - a.count;
    if (byCount !== 0) {
      return byCount;
    }
    return a.activity.localeCompare(b.activity);
  });
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
 * The world-event ring entries scoped to `selection`, newest first (GH124-PLAN.md
 * Checkpoint 5): a train selection scopes to the readings ITS OWN actor id produced
 * (e.g. its train-tracker arrivals); a node selection scopes to readings whose
 * `placeId` names it. One ring, filtered here — never a second buffer.
 */
function placeLog(selection: MapSelection, snapshot: SimSnapshot): WorldLogEvent[] {
  const matches: (event: WorldLogEvent) => boolean =
    selection.kind === "train"
      ? (event) => event.actorId === selection.actorId
      : (event) => event.placeId === selection.id;
  return snapshot.worldEvents.filter(matches).toReversed();
}

/**
 * The whole dialog's content for one `MapSelection`. A train selection carries its
 * onboard riders and no devices (a train has none); a node selection carries its real
 * `world.json` name and type, its devices, and the actors currently at it. Both carry
 * the scoped log.
 */
export function placeView(selection: MapSelection, snapshot: SimSnapshot, world: World): PlaceView {
  if (selection.kind === "train") {
    return {
      title: `Train ${selection.actorId}`,
      iconKind: undefined,
      meta: [],
      devices: [],
      actorRows: actorSummaryRows(selection, snapshot, world),
      log: placeLog(selection, snapshot),
    };
  }
  const node = metroNodes(world).find((candidate) => candidate.id === selection.id);
  if (node === undefined) {
    // Defensive only: every node id the map can select is a fixed world.json fixture
    // (see the store's mapSelection doc), so this should be unreachable in practice.
    return {
      title: selection.id,
      iconKind: undefined,
      meta: [],
      devices: [],
      actorRows: actorSummaryRows(selection, snapshot, world),
      log: placeLog(selection, snapshot),
    };
  }
  return {
    title: node.name,
    iconKind: placeKindForNode(node, world),
    meta: node.kind === "station" ? stationMeta(node, world) : placeMeta(node, world),
    devices: devicesForNode(node.id, world),
    actorRows: actorSummaryRows(selection, snapshot, world),
    log: placeLog(selection, snapshot),
  };
}
