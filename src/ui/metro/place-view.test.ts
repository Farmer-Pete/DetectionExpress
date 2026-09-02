import { describe, expect, it } from "vitest";
import { emptySnapshot, type SimSnapshot } from "../../sim/snapshot";
import { world } from "../../sim/world/world";
import type { WorldLogEvent } from "../../sim/world-log";
import type { ActorView } from "../../sim/world-snapshot";
import {
  actorSummaryRows,
  actorsAtNode,
  describePresence,
  devicesForNode,
  placeView,
  ROLE_LABEL,
} from "./place-view";

function snapshotWith(actors: readonly ActorView[]): SimSnapshot {
  return { ...emptySnapshot(), actors };
}

describe("describePresence", () => {
  it("describes a stationary 'at' presence with no destination as waiting for a train", () => {
    const result = describePresence(
      { kind: "at", node: "cen", fromTick: 0, untilTick: 20 },
      emptySnapshot(),
    );
    expect(result).toBe("waiting for a train");
  });

  it("describes an 'at' presence carrying a chosen destination as heading to it, not waiting", () => {
    const result = describePresence(
      { kind: "at", node: "cen", fromTick: 0, untilTick: 20 },
      emptySnapshot(),
      "riv",
    );
    expect(result).toBe("heading to Riverside");
  });

  it("describes a 'moving' presence as heading to its destination", () => {
    const result = describePresence(
      { kind: "moving", from: "cen", to: "riv", line: "red", fromTick: 0, untilTick: 20 },
      emptySnapshot(),
    );
    expect(result).toBe("heading to Riverside");
  });

  it("resolves an onTrain presence's destination via the named train's ActorView", () => {
    const snapshot = snapshotWith([
      {
        id: "T1",
        kind: "train",
        presence: {
          kind: "moving",
          from: "cen",
          to: "riv",
          line: "red",
          fromTick: 0,
          untilTick: 20,
        },
      },
    ]);
    const result = describePresence(
      { kind: "onTrain", train: "T1", fromTick: 0, untilTick: 20 },
      snapshot,
    );
    expect(result).toBe("heading to Riverside");
  });

  it("resolves an onTrain presence's destination when the train is dwelling ('at')", () => {
    const snapshot = snapshotWith([
      {
        id: "T1",
        kind: "train",
        presence: { kind: "at", node: "riv", fromTick: 5, untilTick: 20 },
      },
    ]);
    const result = describePresence(
      { kind: "onTrain", train: "T1", fromTick: 0, untilTick: 5 },
      snapshot,
    );
    expect(result).toBe("heading to Riverside");
  });

  it("falls back to the resolved train name when the named train is not in the snapshot", () => {
    // T1 (Red Line) is a real train id — one that simply has no live ActorView in this
    // snapshot — never a made-up id like the former "T9", which no line derives.
    const result = describePresence(
      { kind: "onTrain", train: "T1", fromTick: 0, untilTick: 20 },
      emptySnapshot(),
    );
    expect(result).toBe("riding on Red Line train");
  });
});

describe("devicesForNode", () => {
  it("lists a station's four public sensor chips (K, G, V, C)", () => {
    const devices = devicesForNode("cen", world);
    expect(devices.map((device) => device.code)).toEqual(["K", "G", "V", "C"]);
    expect(devices.every((device) => device.state === "public")).toBe(true);
  });

  it("sets each device's name, description, and vendors from the sensor catalogue", () => {
    const devices = devicesForNode("cen", world);
    const gate = devices.find((device) => device.code === "G");
    expect(gate).toMatchObject({
      name: "Fare gate",
      description:
        "The turnstile that guards the paid area. A tap either opens it or does not. It is the Z0 to Z1 boundary in physical form.",
    });
    expect(gate?.vendors).toEqual(["Gatekeep TurnKey 5", "VeriTap FlowGate", "RailSense GateNode"]);
  });

  it("lists a depot/signal site's restricted sensor set (R, D, T, N)", () => {
    const devices = devicesForNode("dep", world);
    expect(devices.map((device) => device.code)).toEqual(["R", "D", "T", "N"]);
    expect(devices.every((device) => device.state === "restricted")).toBe(true);
  });

  it("lists a substation's restricted sensor set (R, D, N), no train tracker", () => {
    const devices = devicesForNode("sub", world);
    expect(devices.map((device) => device.code)).toEqual(["R", "D", "N"]);
  });

  it("lists the OCC's restricted sensor set (R, D, N, O)", () => {
    const devices = devicesForNode("occ", world);
    expect(devices.map((device) => device.code)).toEqual(["R", "D", "N", "O"]);
  });

  it("returns an empty list for an unknown node id", () => {
    expect(devicesForNode("nope", world)).toEqual([]);
  });
});

describe("actorsAtNode", () => {
  it("lists actors whose presence sits 'at' the given node", () => {
    const snapshot = snapshotWith([
      {
        id: "R1",
        kind: "rider",
        presence: { kind: "at", node: "cen", fromTick: 0, untilTick: 20 },
      },
      {
        id: "R2",
        kind: "rider",
        presence: { kind: "at", node: "riv", fromTick: 0, untilTick: 20 },
      },
    ]);
    const lines = actorsAtNode("cen", snapshot);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ id: "R1", glyphKind: "rider", role: "Rider" });
  });

  it("lists a named train's onboard riders when passed the train's id", () => {
    const snapshot = snapshotWith([
      {
        id: "T1",
        kind: "train",
        presence: { kind: "at", node: "riv", fromTick: 0, untilTick: 20 },
      },
      {
        id: "R1",
        kind: "rider",
        presence: { kind: "onTrain", train: "T1", fromTick: 0, untilTick: 20 },
      },
      {
        id: "R2",
        kind: "rider",
        presence: { kind: "at", node: "cen", fromTick: 0, untilTick: 20 },
      },
    ]);
    const lines = actorsAtNode("T1", snapshot);
    expect(lines.map((line) => line.id)).toEqual(["R1"]);
  });

  it("returns an empty list when no actor resolves to the node", () => {
    expect(actorsAtNode("cen", emptySnapshot())).toEqual([]);
  });
});

describe("placeView", () => {
  it("builds a station's view from world data, not a hardcoded name", () => {
    const view = placeView({ kind: "node", id: "cen" }, emptySnapshot(), world);
    expect(view.title).toBe("Central");
    expect(view.iconKind).toBeUndefined();
    expect(view.devices.map((device) => device.code)).toEqual(["K", "G", "V", "C"]);
  });

  it("builds a site's view with its place kind and a resolved zone name in the meta", () => {
    const view = placeView({ kind: "node", id: "dep" }, emptySnapshot(), world);
    expect(view.title).toBe("Eastyard Depot");
    expect(view.iconKind).toBe("depot");
    // Eastyard Depot's zonesPresent (z2, z3) dominate at z3, "Operational".
    expect(view.meta).toContainEqual({ label: "Zone", value: "Z3 · Operational" });
  });

  it("builds the OCC's view as the control-center place kind", () => {
    const view = placeView({ kind: "node", id: "occ" }, emptySnapshot(), world);
    expect(view.title).toBe("Operations Control Center");
    expect(view.iconKind).toBe("control-center");
  });

  it("builds a train's view with its onboard riders and no devices", () => {
    const snapshot = snapshotWith([
      {
        id: "T1",
        kind: "train",
        presence: { kind: "at", node: "riv", fromTick: 0, untilTick: 20 },
      },
      {
        id: "R1",
        kind: "rider",
        presence: { kind: "onTrain", train: "T1", fromTick: 0, untilTick: 20 },
      },
    ]);
    const view = placeView({ kind: "train", actorId: "T1" }, snapshot, world);
    expect(view.title).toBe("Red Line train");
    expect(view.devices).toEqual([]);
    expect(view.actorRows).toEqual([{ kind: "rider", activity: "heading to Riverside", count: 1 }]);
  });
});

describe("actorSummaryRows", () => {
  it("groups actors sharing a kind and activity into one counted row", () => {
    const snapshot = snapshotWith([
      {
        id: "R1",
        kind: "rider",
        presence: { kind: "at", node: "cen", fromTick: 0, untilTick: 20 },
      },
      {
        id: "R2",
        kind: "rider",
        presence: { kind: "at", node: "cen", fromTick: 0, untilTick: 20 },
      },
      {
        id: "R3",
        kind: "rider",
        presence: { kind: "at", node: "cen", fromTick: 0, untilTick: 20 },
        destination: "riv",
      },
    ]);
    const rows = actorSummaryRows({ kind: "node", id: "cen" }, snapshot);
    expect(rows).toEqual([
      { kind: "rider", activity: "waiting for a train", count: 2 },
      { kind: "rider", activity: "heading to Riverside", count: 1 },
    ]);
  });

  it("sorts a threat (pin-attacker) row first regardless of count, tone: threat", () => {
    const snapshot = snapshotWith([
      {
        id: "R1",
        kind: "rider",
        presence: { kind: "at", node: "cen", fromTick: 0, untilTick: 20 },
      },
      {
        id: "R2",
        kind: "rider",
        presence: { kind: "at", node: "cen", fromTick: 0, untilTick: 20 },
      },
      {
        id: "R3",
        kind: "rider",
        presence: { kind: "at", node: "cen", fromTick: 0, untilTick: 20 },
      },
      {
        id: "P1",
        kind: "pin-attacker",
        presence: { kind: "at", node: "cen", fromTick: 0, untilTick: 20 },
      },
    ]);
    const rows = actorSummaryRows({ kind: "node", id: "cen" }, snapshot);
    expect(rows[0]).toEqual({
      kind: "pin-attacker",
      activity: "Pin attacking",
      count: 1,
      tone: "threat",
    });
    expect(rows[0]?.count).toBeLessThan(rows[1]?.count ?? 0);
  });

  it("otherwise sorts by count descending", () => {
    const snapshot = snapshotWith([
      {
        id: "S1",
        kind: "staff",
        presence: { kind: "at", node: "cen", fromTick: 0, untilTick: 20 },
      },
      {
        id: "R1",
        kind: "rider",
        presence: { kind: "at", node: "cen", fromTick: 0, untilTick: 20 },
      },
      {
        id: "R2",
        kind: "rider",
        presence: { kind: "at", node: "cen", fromTick: 0, untilTick: 20 },
      },
    ]);
    const rows = actorSummaryRows({ kind: "node", id: "cen" }, snapshot);
    expect(rows.map((row) => row.kind)).toEqual(["rider", "staff"]);
    expect(rows.map((row) => row.count)).toEqual([2, 1]);
  });

  it("gives a non-trip actor 'at' a node the 'on duty' activity, never 'waiting for a train'", () => {
    const snapshot = snapshotWith([
      {
        id: "S1",
        kind: "staff",
        presence: { kind: "at", node: "cen", fromTick: 0, untilTick: 20 },
      },
    ]);
    const rows = actorSummaryRows({ kind: "node", id: "cen" }, snapshot);
    expect(rows).toEqual([{ kind: "staff", activity: "on duty", count: 1 }]);
  });

  it("labels an account rider at a kiosk 'signing in at a kiosk', never 'waiting for a train'", () => {
    const snapshot = snapshotWith([
      {
        id: "A1",
        kind: "account-rider",
        presence: { kind: "at", node: "cen", fromTick: 0, untilTick: 20 },
      },
    ]);
    const rows = actorSummaryRows({ kind: "node", id: "cen" }, snapshot);
    expect(rows).toEqual([{ kind: "account-rider", activity: "signing in at a kiosk", count: 1 }]);
  });

  it("labels an attacker by its scenario ('Pin attacking'), shown as 'Attacker'", () => {
    const snapshot = snapshotWith([
      {
        id: "X1",
        kind: "pin-attacker",
        presence: { kind: "at", node: "cen", fromTick: 0, untilTick: 20 },
      },
    ]);
    const rows = actorSummaryRows({ kind: "node", id: "cen" }, snapshot);
    expect(rows).toEqual([
      { kind: "pin-attacker", activity: "Pin attacking", count: 1, tone: "threat" },
    ]);
    expect(ROLE_LABEL["pin-attacker"]).toBe("Attacker");
  });

  it("excludes a future-parked actor whose 'at' window has not opened yet", () => {
    const snapshot: SimSnapshot = {
      ...emptySnapshot(),
      nowTick: 10,
      actors: [
        {
          id: "here",
          kind: "account-rider",
          presence: { kind: "at", node: "cen", fromTick: 5, untilTick: 20 },
        },
        {
          id: "future",
          kind: "account-rider",
          presence: { kind: "at", node: "cen", fromTick: 900, untilTick: 900 },
        },
      ],
    };
    const rows = actorSummaryRows({ kind: "node", id: "cen" }, snapshot);
    expect(rows).toEqual([{ kind: "account-rider", activity: "signing in at a kiosk", count: 1 }]);
  });

  it("returns an empty table for a node with no actors", () => {
    expect(actorSummaryRows({ kind: "node", id: "cen" }, emptySnapshot())).toEqual([]);
  });
});

/** A minimal `WorldLogEvent` at `placeId`, with `actorId` when given. */
function worldEvent(id: number, placeId: string, actorId?: string): WorldLogEvent {
  const base = {
    id,
    ts: id,
    sensor: "fare-gate" as const,
    placeId,
    reading: {
      sensor: "fare-gate" as const,
      reading: {
        ts: id,
        card: "c",
        station: placeId,
        line: "red",
        direction: "in" as const,
        result: "ok" as const,
        balance: 10,
      },
    },
    scored: false,
  };
  return actorId === undefined ? base : { ...base, actorId };
}

describe("placeView: the scoped log (GH124-PLAN.md Checkpoint 5)", () => {
  it("scopes a node selection's log to worldEvents whose placeId matches, newest first", () => {
    const snapshot: SimSnapshot = {
      ...emptySnapshot(),
      worldEvents: [worldEvent(0, "cen"), worldEvent(1, "riv"), worldEvent(2, "cen")],
    };
    const view = placeView({ kind: "node", id: "cen" }, snapshot, world);
    expect(view.log.map((e) => e.id)).toEqual([2, 0]);
  });

  it("scopes a train selection's log to worldEvents whose actorId matches the train", () => {
    const snapshot: SimSnapshot = {
      ...emptySnapshot(),
      worldEvents: [
        worldEvent(0, "cen", "T1"),
        worldEvent(1, "riv", "T2"),
        worldEvent(2, "cen", "T1"),
      ],
    };
    const view = placeView({ kind: "train", actorId: "T1" }, snapshot, world);
    expect(view.log.map((e) => e.id)).toEqual([2, 0]);
  });

  it("returns an empty log when nothing in the ring matches the selection", () => {
    const snapshot: SimSnapshot = { ...emptySnapshot(), worldEvents: [worldEvent(0, "riv")] };
    expect(placeView({ kind: "node", id: "cen" }, snapshot, world).log).toEqual([]);
  });
});
