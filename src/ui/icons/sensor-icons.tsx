/**
 * The single source of truth mapping a sensor code or a place kind to its lucide
 * icon: the map chips (`MetroMap.tsx`), the map legend (`MetroView.tsx`), the event
 * log, and the place-dialog device cards all read icons from here so the nine
 * sensor glyphs and four place glyphs never drift between consumers.
 *
 * Each `Record` is keyed by a closed union (`SensorCode`, `PlaceKind`), so a missing
 * arm is a `tsc` error, not a runtime gap.
 */
import type { LucideIcon } from "lucide-react";
import {
  Cctv,
  DoorClosed,
  IdCard,
  LayoutDashboard,
  LogIn,
  Monitor,
  Radio,
  RadioTower,
  SlidersHorizontal,
  Ticket,
  TrainFront,
  Warehouse,
  Zap,
} from "lucide-react";
import type { SensorCode } from "../../sim/world/layout";

/** A site's `type` (`world.ts`'s `SITE_TYPES`), plus the one control center. */
export type PlaceKind = "depot" | "signal-cabin" | "substation" | "control-center";

/** A sensor's icon and its existing `--s-*` color token (`index.css`) as a `var()` string. */
export interface SensorIconSpec {
  readonly Icon: LucideIcon;
  readonly token: string;
}

const SENSOR_ICONS: Record<SensorCode, SensorIconSpec> = {
  K: { Icon: Monitor, token: "var(--s-kiosk)" },
  G: { Icon: LogIn, token: "var(--s-gate)" },
  V: { Icon: Ticket, token: "var(--s-tvm)" },
  C: { Icon: Cctv, token: "var(--s-cam)" },
  R: { Icon: IdCard, token: "var(--s-reader)" },
  D: { Icon: DoorClosed, token: "var(--s-contact)" },
  T: { Icon: TrainFront, token: "var(--s-train)" },
  N: { Icon: Radio, token: "var(--s-relay)" },
  O: { Icon: SlidersHorizontal, token: "var(--s-console)" },
};

/** A sensor code's icon and color token. */
export function sensorIcon(code: SensorCode): SensorIconSpec {
  return SENSOR_ICONS[code];
}

const PLACE_ICONS: Record<PlaceKind, LucideIcon> = {
  depot: Warehouse,
  "signal-cabin": RadioTower,
  substation: Zap,
  "control-center": LayoutDashboard,
};

/**
 * A place kind's icon. Places have no color token of their own (the map's zone
 * badge already carries color for sites and the OCC), so this returns only the icon.
 */
export function placeIcon(kind: PlaceKind): LucideIcon {
  return PLACE_ICONS[kind];
}
