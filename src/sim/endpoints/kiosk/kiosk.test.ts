import { describe, expect, it } from "vitest";
import { referenceAlgorithm } from "../../scenarios/kiosk-pin-attack/reference";
import { isRawKioskV1, kioskV1, type RawKioskV1 } from "./formats/kiosk-v1";
import type { AccountKioskReading } from "./internal";

/** A unified kiosk record the actor path emits: station included, outcome widened. */
const success: AccountKioskReading = {
  ts: 42,
  account: "root",
  station: "cen",
  terminal: "K1",
  outcome: "success",
};
const fail: AccountKioskReading = { ...success, outcome: "fail" };

describe("kioskV1.format", () => {
  it("has the endpoint id", () => {
    expect(kioskV1.id).toBe("kiosk-v1");
  });

  it("maps the terse wire keys and encodes a success as OK", () => {
    expect(kioskV1.format(success)).toEqual({
      t: 42,
      acct: "root",
      term: "K1",
      res: "OK",
    });
  });

  it("encodes a wrong PIN (a fail) as WRONG_PIN", () => {
    expect(kioskV1.format(fail).res).toBe("WRONG_PIN");
  });

  it("keeps the station off the wire", () => {
    expect(kioskV1.format(success)).not.toHaveProperty("station");
  });
});

describe("isRawKioskV1", () => {
  it("accepts a valid kiosk-v1 reading", () => {
    expect(isRawKioskV1({ t: 1, acct: "root", term: "K1", res: "OK" })).toBe(true);
    expect(isRawKioskV1({ t: 1, acct: "root", term: "K1", res: "WRONG_PIN" })).toBe(true);
  });

  it("rejects a malformed payload", () => {
    expect(isRawKioskV1({ t: 1, acct: "root" })).toBe(false);
    expect(isRawKioskV1({ t: 1, acct: "root", term: "K1", res: "MAYBE" })).toBe(false);
    expect(isRawKioskV1(null)).toBe(false);
  });

  it("round-trips a formatted record", () => {
    expect(isRawKioskV1(kioskV1.format(success))).toBe(true);
    expect(isRawKioskV1(kioskV1.format(fail))).toBe(true);
  });
});

describe("reference normalize round trip", () => {
  it("recovers account, terminal, and outcome from a kiosk-v1 reading", () => {
    const raw: RawKioskV1 = { t: 5, acct: "root", term: "K1", res: "WRONG_PIN" };
    expect(referenceAlgorithm.normalize(raw)).toEqual({
      account: "root",
      terminal: "K1",
      outcome: "fail",
    });
    const ok: RawKioskV1 = { t: 5, acct: "root", term: "K1", res: "OK" };
    expect(referenceAlgorithm.normalize(ok).outcome).toBe("success");
  });
});
