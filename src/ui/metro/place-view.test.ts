import { describe, expect, it } from "vitest";
import { emptySnapshot, type SimSnapshot } from "../../sim/snapshot";
import { world } from "../../sim/world/world";
import type { WorldLogEvent } from "../../sim/world-log";
import type { ActorView } from "../../sim/world-snapshot";
import { actorsAtNode, describePresence, devicesForNode, placeView } from "./place-view";

function snapshotWith(actors: readonly ActorView[]): SimSnapshot {
  return { ...emptySnapshot(), actors };
}

describe("describePresence", () => {
  it("describes a stationary 'at' presence as waiting at its node", () => {
    const result = describePresence(
      { kind: "at", node: "cen", fromTick: 0, untilTick: 20 },
      emptySnapshot(),
      world,
    );
    expect(result).toEqual({ doing: "waiting", heading: "at Central" });
  });

  it("describes an open-ended 'at' presence (a fixture) as stationed", () => {
    const result = describePresence(
      { kind: "at", node: "occ", fromTick: 0, untilTick: "open" },
      emptySnapshot(),
      world,
    );
    expect(result.doing).toBe("stationed");
  });

  it("describes a 'moving' presence as walking toward its destination", () => {
    const result = describePresence(
      { kind: "moving", from: "cen", to: "riv", line: "red", fromTick: 0, untilTick: 20 },
      emptySnapshot(),
      world,
    );
    expect(result).toEqual({ doing: "walking", heading: "to Riverside" });
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
      world,
    );
    expect(result).toEqual({ doing: "riding", heading: "to Riverside" });
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
      world,
    );
    expect(result).toEqual({ doing: "riding", heading: "to Riverside" });
  });

  it("falls back gracefully when the named train is not in the snapshot", () => {
    const result = describePresence(
      { kind: "onTrain", train: "T9", fromTick: 0, untilTick: 20 },
      emptySnapshot(),
      world,
    );
    expect(result.doing).toBe("riding");
    expect(result.heading).toBe("on T9");
  });
});

describe("devicesForNode", () => {
  it("lists a station's four public sensor chips (K, G, V, C)", () => {
    const devices = devicesForNode("cen", world);
    expect(devices.map((device) => device.code)).toEqual(["K", "G", "V", "C"]);
    expect(devices.every((device) => device.state === "public")).toBe(true);
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
    const lines = actorsAtNode("cen", snapshot, world);
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
    const lines = actorsAtNode("T1", snapshot, world);
    expect(lines.map((line) => line.id)).toEqual(["R1"]);
  });

  it("returns an empty list when no actor resolves to the node", () => {
    expect(actorsAtNode("cen", emptySnapshot(), world)).toEqual([]);
  });
});

describe("placeView", () => {
  it("builds a station's view from world data, not a hardcoded name", () => {
    const view = placeView({ kind: "node", id: "cen" }, emptySnapshot(), world);
    expect(view.title).toBe("Central");
    expect(view.iconKind).toBeUndefined();
    expect(view.devices.map((device) => device.code)).toEqual(["K", "G", "V", "C"]);
  });

  it("builds a site's view with its place kind and zone meta", () => {
    const view = placeView({ kind: "node", id: "dep" }, emptySnapshot(), world);
    expect(view.title).toBe("Eastyard Depot");
    expect(view.iconKind).toBe("depot");
    expect(view.meta.some((badge) => badge.label === "Zone")).toBe(true);
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
    expect(view.title).toContain("T1");
    expect(view.devices).toEqual([]);
    expect(view.actors.map((line) => line.id)).toEqual(["R1"]);
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
