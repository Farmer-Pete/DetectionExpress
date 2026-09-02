import { describe, expect, it } from "vitest";
import type { WorldLogEvent } from "../../sim/world-log";
import { formatRow, toLogRow } from "./formatters";

describe("formatRow", () => {
  it("maps a kiosk-v1 OK reading to who/where/result and an ok tone", () => {
    const raw = { t: 12, acct: "acct-1", term: "term-1", res: "OK" };
    expect(formatRow("kiosk-v1", raw)).toEqual({
      who: "acct-1",
      where: "term-1",
      result: "OK",
      tone: "ok",
    });
  });

  it("marks a kiosk-v1 WRONG_PIN reading with a bad tone", () => {
    const raw = { t: 12, acct: "acct-1", term: "term-1", res: "WRONG_PIN" };
    expect(formatRow("kiosk-v1", raw)).toEqual({
      who: "acct-1",
      where: "term-1",
      result: "WRONG_PIN",
      tone: "bad",
    });
  });

  it("maps a gatekeep-turnkey PERMIT reading to who/where/result and an ok tone", () => {
    const raw = {
      EVENT_TIME: "2025-08-29T00:00:00.000Z",
      MEDIA_SERIAL: "card-1",
      STATION_CODE: "STN-1",
      LINE_ID: "LINE-1",
      DIRECTION: "ENTRY",
      GATE_RESULT: "PERMIT",
      STORED_VALUE: 500,
    };
    expect(formatRow("gatekeep-turnkey", raw)).toEqual({
      who: "card-1",
      where: "STN-1",
      result: "PERMIT",
      tone: "ok",
    });
  });

  it("marks a gatekeep-turnkey REJECT reading with a bad tone", () => {
    const raw = {
      EVENT_TIME: "2025-08-29T00:00:00.000Z",
      MEDIA_SERIAL: "card-1",
      STATION_CODE: "STN-1",
      LINE_ID: "LINE-1",
      DIRECTION: "EXIT",
      GATE_RESULT: "REJECT",
      STORED_VALUE: 0,
    };
    expect(formatRow("gatekeep-turnkey", raw)).toEqual({
      who: "card-1",
      where: "STN-1",
      result: "REJECT",
      tone: "bad",
    });
  });

  it("falls back to compact JSON for an unknown endpoint", () => {
    const raw = { a: 1, b: "two" };
    expect(formatRow("some-other-endpoint", raw)).toEqual({
      who: "",
      where: "some-other-endpoint",
      result: '{"a":1,"b":"two"}',
      tone: "neutral",
    });
  });

  it("falls back to compact JSON when a raw payload does not match its endpoint's shape", () => {
    const raw = { unexpected: "shape" };
    expect(formatRow("kiosk-v1", raw)).toEqual({
      who: "",
      where: "kiosk-v1",
      result: '{"unexpected":"shape"}',
      tone: "neutral",
    });
  });

  it("falls back rather than throwing when a kiosk-v1 payload has a non-string acct or term", () => {
    // The field names and res are all present and valid, but acct is an object and term
    // is a number. The kiosk-v1 guard rejects the non-string fields, so the formatter
    // degrades to the JSON fallback instead of rendering an object as a React child.
    const raw = { t: null, acct: {}, term: 42, res: "OK" };
    expect(() => formatRow("kiosk-v1", raw)).not.toThrow();
    expect(formatRow("kiosk-v1", raw)).toEqual({
      who: "",
      where: "kiosk-v1",
      result: JSON.stringify(raw),
      tone: "neutral",
    });
  });

  it("does not throw on a null raw payload for a known endpoint", () => {
    expect(() => formatRow("gatekeep-turnkey", null)).not.toThrow();
    expect(formatRow("gatekeep-turnkey", null)).toEqual({
      who: "",
      where: "gatekeep-turnkey",
      result: "null",
      tone: "neutral",
    });
  });
});

/** A minimal `WorldLogEvent` for `sensor`, its `reading`, with everything else a
 *  reasonable default. Only `id`/`ts`/`sensor`/`reading` vary across the cases below. */
function worldEvent(
  overrides: Partial<WorldLogEvent> & Pick<WorldLogEvent, "reading">,
): WorldLogEvent {
  return {
    id: 0,
    ts: 12,
    sensor: overrides.reading.sensor,
    placeId: "cen",
    scored: false,
    ...overrides,
  };
}

describe("toLogRow", () => {
  it("maps a kiosk success reading to who/where/result and an ok tone", () => {
    const row = toLogRow(
      worldEvent({
        reading: {
          sensor: "kiosk",
          reading: {
            ts: 12,
            account: "acct-1",
            station: "cen",
            terminal: "K1",
            outcome: "success",
          },
        },
      }),
    );
    expect(row).toMatchObject({ who: "acct-1", where: "K1", result: "OK", tone: "ok" });
  });

  it("marks a kiosk fail reading with a bad tone", () => {
    const row = toLogRow(
      worldEvent({
        reading: {
          sensor: "kiosk",
          reading: { ts: 12, account: "acct-1", station: "cen", terminal: "K1", outcome: "fail" },
        },
      }),
    );
    expect(row).toMatchObject({ result: "WRONG_PIN", tone: "bad" });
  });

  it("maps a fare-gate ok reading to PERMIT and an ok tone", () => {
    const row = toLogRow(
      worldEvent({
        reading: {
          sensor: "fare-gate",
          reading: {
            ts: 12,
            card: "card-1",
            station: "cen",
            line: "red",
            direction: "in",
            result: "ok",
            balance: 50,
          },
        },
      }),
    );
    expect(row).toMatchObject({ who: "card-1", where: "cen", result: "PERMIT", tone: "ok" });
  });

  it("marks a fare-gate reject reading with a bad tone", () => {
    const row = toLogRow(
      worldEvent({
        reading: {
          sensor: "fare-gate",
          reading: {
            ts: 12,
            card: "card-1",
            station: "cen",
            line: "red",
            direction: "in",
            result: "reject",
            balance: 0,
          },
        },
      }),
    );
    expect(row).toMatchObject({ result: "REJECT", tone: "bad" });
  });

  it("maps a tvm top-up to a +amount result and an ok tone", () => {
    const row = toLogRow(
      worldEvent({
        reading: {
          sensor: "tvm",
          reading: {
            ts: 12,
            card: "c1",
            station: "cen",
            machine: "V1",
            amount: 100,
            kind: "topup",
          },
        },
      }),
    );
    expect(row).toMatchObject({ who: "c1", where: "cen", result: "+100", tone: "ok" });
  });

  it("maps a train-tracker arrival/departure to ARRIVED/DEPARTED with a neutral tone", () => {
    const arr = toLogRow(
      worldEvent({
        reading: {
          sensor: "train-tracker",
          reading: { ts: 12, train: "T1", line: "red", station: "cen", event: "arr", track: "1" },
        },
      }),
    );
    expect(arr).toMatchObject({ who: "T1", where: "cen", result: "ARRIVED", tone: "neutral" });

    const dep = toLogRow(
      worldEvent({
        reading: {
          sensor: "train-tracker",
          reading: { ts: 12, train: "T1", line: "red", station: "cen", event: "dep", track: "1" },
        },
      }),
    );
    expect(dep).toMatchObject({ result: "DEPARTED" });
  });

  it("maps a door-reader grant to GRANTED with an ok tone", () => {
    const row = toLogRow(
      worldEvent({
        reading: {
          sensor: "door-reader",
          reading: { ts: 12, badge: "B1", site: "dep", door: "D1", zone: "z1", result: "grant" },
        },
      }),
    );
    expect(row).toMatchObject({ who: "B1", where: "dep", result: "GRANTED", tone: "ok" });
  });

  it("maps door-contact open/close with no `who` (no actor) and a neutral tone", () => {
    const open = toLogRow(
      worldEvent({
        reading: {
          sensor: "door-contact",
          reading: { ts: 12, site: "dep", door: "D1", event: "open" },
        },
      }),
    );
    expect(open).toMatchObject({ who: "", where: "dep", result: "OPENED", tone: "neutral" });

    const close = toLogRow(
      worldEvent({
        reading: {
          sensor: "door-contact",
          reading: { ts: 12, site: "dep", door: "D1", event: "close" },
        },
      }),
    );
    expect(close).toMatchObject({ result: "CLOSED" });
  });

  it("maps platform-camera to a persons-in-view result with a neutral tone", () => {
    const row = toLogRow(
      worldEvent({
        reading: {
          sensor: "platform-camera",
          reading: { ts: 12, station: "cen", gate: "cen:gate", grants: 3, persons: 3 },
        },
      }),
    );
    expect(row).toMatchObject({ who: "", where: "cen", result: "3 in view", tone: "neutral" });
  });

  it("maps occ-console to an operator/host/command-target row with a neutral tone", () => {
    const row = toLogRow(
      worldEvent({
        reading: {
          sensor: "occ-console",
          reading: { ts: 12, operator: "red.disp", host: "OCC-1", command: "route", target: "T1" },
        },
      }),
    );
    expect(row).toMatchObject({
      who: "red.disp",
      where: "OCC-1",
      result: "route T1",
      tone: "neutral",
    });
  });

  it("maps network-relay to a byte-count result with a neutral tone", () => {
    const row = toLogRow(
      worldEvent({
        reading: {
          sensor: "network-relay",
          reading: { ts: 12, site: "dep", host: "YARD-NET-1", dest: "core", bytes: 512 },
        },
      }),
    );
    expect(row).toMatchObject({
      who: "YARD-NET-1",
      where: "core",
      result: "512B",
      tone: "neutral",
    });
  });

  it("carries the world-log id, ts, and sensor through unchanged", () => {
    const row = toLogRow(
      worldEvent({
        id: 42,
        ts: 99,
        reading: {
          sensor: "kiosk",
          reading: { ts: 99, account: "a", station: "cen", terminal: "K1", outcome: "success" },
        },
      }),
    );
    expect(row.id).toBe(42);
    expect(row.ts).toBe(99);
    expect(row.sensor).toBe("kiosk");
  });
});
