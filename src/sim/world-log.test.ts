import { describe, expect, it } from "vitest";
import type { SensorCode } from "./world/layout";
import {
  createWorldLog,
  type SensorKind,
  sensorCodeFor,
  sensorKindForCode,
  type WorldLogEntry,
} from "./world-log";

const ALL_SENSOR_KINDS: readonly SensorKind[] = [
  "kiosk",
  "fare-gate",
  "tvm",
  "platform-camera",
  "door-reader",
  "door-contact",
  "train-tracker",
  "network-relay",
  "occ-console",
];

const ALL_SENSOR_CODES: readonly SensorCode[] = ["K", "G", "V", "C", "R", "D", "T", "N", "O"];

function kioskEntry(overrides: Partial<WorldLogEntry> = {}): WorldLogEntry {
  return {
    ts: 0,
    sensor: "kiosk",
    placeId: "cen",
    chipNode: "cen:kiosk",
    actorId: "patron-0",
    reading: {
      sensor: "kiosk",
      reading: { ts: 0, account: "rider", station: "cen", terminal: "K1", outcome: "success" },
    },
    scored: false,
    ...overrides,
  };
}

describe("sensorCodeFor / sensorKindForCode: exhaustive, bijective converter", () => {
  it("maps every canonical sensor kind to a distinct SensorCode", () => {
    const codes = ALL_SENSOR_KINDS.map(sensorCodeFor);
    expect(new Set(codes).size).toBe(ALL_SENSOR_KINDS.length);
    for (const code of codes) {
      expect(ALL_SENSOR_CODES).toContain(code);
    }
  });

  it("round-trips every sensor kind through its code and back", () => {
    for (const kind of ALL_SENSOR_KINDS) {
      expect(sensorKindForCode(sensorCodeFor(kind))).toBe(kind);
    }
  });

  it("round-trips every SensorCode through its kind and back", () => {
    for (const code of ALL_SENSOR_CODES) {
      expect(sensorCodeFor(sensorKindForCode(code))).toBe(code);
    }
  });
});

describe("createWorldLog", () => {
  it("assigns dense ids in push order, in its own namespace", () => {
    const log = createWorldLog(10);
    log.push(kioskEntry());
    log.push(kioskEntry());
    log.push(kioskEntry());
    expect(log.snapshot().map((e) => e.id)).toEqual([0, 1, 2]);
  });

  it("evicts the oldest entry once capacity is exceeded, like the inspector ring", () => {
    const log = createWorldLog(3);
    for (let i = 0; i < 5; i++) {
      log.push(kioskEntry({ ts: i }));
    }
    const snap = log.snapshot();
    expect(snap.map((e) => e.id)).toEqual([2, 3, 4]);
    expect(snap).toHaveLength(3);
  });

  it("returns a fresh array each call; mutating one snapshot never affects the next", () => {
    const log = createWorldLog(10);
    log.push(kioskEntry());
    const first = log.snapshot();
    log.push(kioskEntry());
    const second = log.snapshot();
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(2);
    expect(first).not.toBe(second);
  });

  it("deep-freezes every pushed entry, including its nested reading", () => {
    const log = createWorldLog(10);
    log.push(kioskEntry());
    const [entry] = log.snapshot();
    expect(entry).toBeDefined();
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry?.reading)).toBe(true);
    expect(Object.isFrozen(entry?.reading.reading)).toBe(true);
  });

  it("carries scored/scoredEventId only when the caller sets them", () => {
    const log = createWorldLog(10);
    log.push(kioskEntry({ scored: true, scoredEventId: 7 }));
    log.push(kioskEntry({ scored: false }));
    const [scored, unscored] = log.snapshot();
    expect(scored?.scored).toBe(true);
    expect(scored?.scoredEventId).toBe(7);
    expect(unscored?.scored).toBe(false);
    expect(unscored?.scoredEventId).toBeUndefined();
  });

  it("omits chipNode for a train-tracker entry, keying off placeId alone", () => {
    const log = createWorldLog(10);
    log.push({
      ts: 0,
      sensor: "train-tracker",
      placeId: "cen",
      actorId: "T1",
      reading: {
        sensor: "train-tracker",
        reading: { ts: 0, train: "T1", line: "red", station: "cen", event: "arr", track: "1" },
      },
      scored: false,
    });
    const [entry] = log.snapshot();
    expect(entry?.chipNode).toBeUndefined();
    expect(entry?.placeId).toBe("cen");
  });
});
