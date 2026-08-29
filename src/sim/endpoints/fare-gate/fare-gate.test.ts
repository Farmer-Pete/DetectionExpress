import { describe, expect, it } from "vitest";
import {
  type FareGateReading,
  gatekeepGate,
  isRawGatekeepGate,
  type RawGatekeepGate,
} from "./gatekeep";

describe("gatekeepGate.format", () => {
  const entry: FareGateReading = {
    ts: 0,
    card: "C09",
    station: "cen",
    line: "red",
    direction: "in",
    result: "ok",
    balance: 250,
  };

  it("has the endpoint id", () => {
    expect(gatekeepGate.id).toBe("gatekeep-turnkey");
  });

  it("maps every field, upper-casing codes and spelling out the Gatekeep words", () => {
    // The EVENT_TIME literal is the example time in docs/world/sensors.json.
    expect(gatekeepGate.format(entry)).toEqual({
      EVENT_TIME: "2025-08-29T02:14:03.000Z",
      MEDIA_SERIAL: "C09",
      STATION_CODE: "CEN",
      LINE_ID: "RED",
      DIRECTION: "ENTRY",
      GATE_RESULT: "PERMIT",
      STORED_VALUE: 250,
    });
  });

  it("maps an exit rejection to EXIT and REJECT", () => {
    const exit: FareGateReading = { ...entry, direction: "out", result: "reject" };
    const raw = gatekeepGate.format(exit);
    expect(raw.DIRECTION).toBe("EXIT");
    expect(raw.GATE_RESULT).toBe("REJECT");
  });

  it("derives EVENT_TIME deterministically from the game-second ts", () => {
    expect(gatekeepGate.format({ ...entry, ts: 300 }).EVENT_TIME).toBe("2025-08-29T02:19:03.000Z");
  });
});

describe("isRawGatekeepGate", () => {
  const valid: RawGatekeepGate = {
    EVENT_TIME: "2025-08-29T02:14:03Z",
    MEDIA_SERIAL: "C09",
    STATION_CODE: "CEN",
    LINE_ID: "RED",
    DIRECTION: "ENTRY",
    GATE_RESULT: "PERMIT",
    STORED_VALUE: 250,
  };

  it("accepts a real payload", () => {
    expect(isRawGatekeepGate(valid)).toBe(true);
    expect(isRawGatekeepGate({ ...valid, DIRECTION: "EXIT", GATE_RESULT: "REJECT" })).toBe(true);
  });

  it("rejects a near-miss on a union value", () => {
    expect(isRawGatekeepGate({ ...valid, DIRECTION: "IN" })).toBe(false);
    expect(isRawGatekeepGate({ ...valid, GATE_RESULT: "OK" })).toBe(false);
  });

  it("rejects every wrong-typed field", () => {
    expect(isRawGatekeepGate({ ...valid, EVENT_TIME: 123 })).toBe(false);
    expect(isRawGatekeepGate({ ...valid, MEDIA_SERIAL: 5 })).toBe(false);
    expect(isRawGatekeepGate({ ...valid, STATION_CODE: null })).toBe(false);
    expect(isRawGatekeepGate({ ...valid, LINE_ID: {} })).toBe(false);
    expect(isRawGatekeepGate({ ...valid, STORED_VALUE: "250" })).toBe(false);
  });

  it("rejects a missing field and a non-object", () => {
    expect(
      isRawGatekeepGate({
        EVENT_TIME: valid.EVENT_TIME,
        MEDIA_SERIAL: valid.MEDIA_SERIAL,
        STATION_CODE: valid.STATION_CODE,
        LINE_ID: valid.LINE_ID,
        DIRECTION: valid.DIRECTION,
        GATE_RESULT: valid.GATE_RESULT,
      }),
    ).toBe(false);
    expect(isRawGatekeepGate(null)).toBe(false);
  });
});
