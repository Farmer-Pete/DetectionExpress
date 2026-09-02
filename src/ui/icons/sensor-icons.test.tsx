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
import { describe, expect, it } from "vitest";
import type { SensorCode } from "../../sim/world/layout";
import { type PlaceKind, placeIcon, sensorIcon } from "./sensor-icons";

/** Every sensor code, independent of the lookup under test (`layout.ts`'s union). */
const ALL_CODES: readonly SensorCode[] = ["K", "G", "V", "C", "R", "D", "T", "N", "O"];

/** Every place kind: the three `world.ts` site types plus the control center. */
const ALL_PLACE_KINDS: readonly PlaceKind[] = [
  "depot",
  "signal-cabin",
  "substation",
  "control-center",
];

describe("sensorIcon", () => {
  it.each([
    ["K", Monitor, "var(--s-kiosk)"],
    ["G", LogIn, "var(--s-gate)"],
    ["V", Ticket, "var(--s-tvm)"],
    ["C", Cctv, "var(--s-cam)"],
    ["R", IdCard, "var(--s-reader)"],
    ["D", DoorClosed, "var(--s-contact)"],
    ["T", TrainFront, "var(--s-train)"],
    ["N", Radio, "var(--s-relay)"],
    ["O", SlidersHorizontal, "var(--s-console)"],
  ] as const)("maps %s to its lucide icon and color token", (code, expectedIcon, expectedToken) => {
    const spec = sensorIcon(code);
    expect(spec.Icon).toBe(expectedIcon);
    expect(spec.token).toBe(expectedToken);
  });

  it("covers every sensor code with no gaps", () => {
    for (const code of ALL_CODES) {
      const spec = sensorIcon(code);
      expect(spec.Icon).toBeDefined();
      expect(spec.token).toMatch(/^var\(--s-[a-z]+\)$/);
    }
  });

  it("rejects a code outside the sensor union at the type level", () => {
    // @ts-expect-error "Q" is not a SensorCode; tsc must reject this call.
    sensorIcon("Q");
  });
});

describe("placeIcon", () => {
  it.each([
    ["depot", Warehouse],
    ["signal-cabin", RadioTower],
    ["substation", Zap],
    ["control-center", LayoutDashboard],
  ] as const)("maps %s to its lucide icon", (kind, expectedIcon) => {
    expect(placeIcon(kind)).toBe(expectedIcon);
  });

  it("covers every place kind with no gaps", () => {
    for (const kind of ALL_PLACE_KINDS) {
      expect(placeIcon(kind)).toBeDefined();
    }
  });

  it("rejects a kind outside the place union at the type level", () => {
    // @ts-expect-error "hangar" is not a PlaceKind; tsc must reject this call.
    placeIcon("hangar");
  });
});
