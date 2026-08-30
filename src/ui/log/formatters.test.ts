import { describe, expect, it } from "vitest";
import { formatRow } from "./formatters";

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
