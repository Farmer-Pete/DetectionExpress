import { describe, expect, it } from "bun:test";
import { en, Faker } from "@faker-js/faker";
import { randomLcg } from "d3-random";
import { referenceAlgorithm } from "../../scenarios/kiosk-pin-attack/reference";
import type { GenContext } from "../endpoint";
import { isRawKioskV1, kioskV1, type RawKioskV1 } from "./formats/kiosk-v1";
import { generateKiosk, type KioskReading } from "./internal";

/** A seeded GenContext, the way the Scenario builds one. */
function context(seed: number, over: Partial<GenContext> = {}): GenContext {
  const faker = new Faker({ locale: en });
  faker.seed(seed);
  return {
    rng: randomLcg(seed),
    faker,
    ts: 0,
    account: "root",
    outcome: "fail",
    ...over,
  };
}

describe("generateKiosk", () => {
  it("is deterministic for a seed and intent", () => {
    const a = generateKiosk(context(7));
    const b = generateKiosk(context(7));
    expect(a).toEqual(b);
  });

  it("renders the intent's identity, time, and outcome", () => {
    const r = generateKiosk(context(7, { ts: 42, account: "alice", outcome: "fail" }));
    expect(r.ts).toBe(42);
    expect(r.account).toBe("alice");
    expect(r.outcome).toBe("fail");
    expect(r.terminal).toMatch(/^KIOSK-\d{2}$/);
  });
});

describe("kioskV1.format", () => {
  const record: KioskReading = { ts: 42, account: "root", terminal: "KIOSK-01", outcome: "fail" };

  it("has the endpoint id", () => {
    expect(kioskV1.id).toBe("kiosk-v1");
  });

  it("maps every field, encoding a wrong PIN as WRONG_PIN", () => {
    expect(kioskV1.format(record)).toEqual({
      t: 42,
      acct: "root",
      term: "KIOSK-01",
      res: "WRONG_PIN",
    });
    expect(kioskV1.format({ ...record, outcome: "success" }).res).toBe("OK");
  });
});

describe("isRawKioskV1", () => {
  it("accepts a valid kiosk-v1 reading", () => {
    expect(isRawKioskV1({ t: 1, acct: "root", term: "KIOSK-01", res: "OK" })).toBe(true);
    expect(isRawKioskV1({ t: 1, acct: "root", term: "KIOSK-01", res: "WRONG_PIN" })).toBe(true);
  });

  it("rejects a malformed payload", () => {
    expect(isRawKioskV1({ t: 1, acct: "root" })).toBe(false);
    expect(isRawKioskV1({ t: 1, acct: "root", term: "KIOSK-01", res: "MAYBE" })).toBe(false);
    expect(isRawKioskV1(null)).toBe(false);
  });
});

describe("reference normalize round trip", () => {
  it("recovers account, terminal, and outcome from a kiosk-v1 reading", () => {
    const raw: RawKioskV1 = { t: 5, acct: "root", term: "KIOSK-01", res: "WRONG_PIN" };
    expect(referenceAlgorithm.normalize(raw)).toEqual({
      account: "root",
      terminal: "KIOSK-01",
      outcome: "fail",
    });
    const ok: RawKioskV1 = { t: 5, acct: "root", term: "KIOSK-01", res: "OK" };
    expect(referenceAlgorithm.normalize(ok).outcome).toBe("success");
  });
});
