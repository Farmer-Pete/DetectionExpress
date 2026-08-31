import { describe, expect, it } from "vitest";
import { kioskV1, type RawKioskV1 } from "./formats/kiosk-v1";
import { normalizeKiosk, normalizers } from "./normalize";

describe("normalizeKiosk", () => {
  it("recovers account, terminal, and outcome from a kiosk-v1 reading", () => {
    const raw: RawKioskV1 = { t: 5, acct: "root", term: "K1", res: "WRONG_PIN" };
    expect(normalizeKiosk(raw)).toEqual({ account: "root", terminal: "K1", outcome: "fail" });
    const ok: RawKioskV1 = { t: 5, acct: "root", term: "K1", res: "OK" };
    expect(normalizeKiosk(ok).outcome).toBe("success");
  });

  it("rejects a res outside {WRONG_PIN, OK} rather than defaulting it to success", () => {
    const malformed = { t: 5, acct: "root", term: "K1", res: "GARBAGE" };
    expect(() => normalizeKiosk(malformed)).toThrow(/res.*"WRONG_PIN"|"OK"/);
  });

  it("rejects a non-string res the same way", () => {
    const malformed = { t: 5, acct: "root", term: "K1", res: 1 };
    expect(() => normalizeKiosk(malformed)).toThrow(/res/);
  });

  it("rejects a res that only differs in case from the known tokens", () => {
    const malformed = { t: 5, acct: "root", term: "K1", res: "ok" };
    expect(() => normalizeKiosk(malformed)).toThrow(/res/);
  });
});

describe("kiosk normalizers registry", () => {
  it("keys the normalizer under the kiosk-v1 endpoint id, without drift", () => {
    // The map key is the literal "kiosk-v1" (assembler-friendly); guard it against
    // drifting from the endpoint's own id.
    expect(Object.keys(normalizers)).toEqual([kioskV1.id]);
  });

  it("dispatches a raw payload through the registered normalizer", () => {
    const normalize = normalizers[kioskV1.id];
    expect(normalize?.({ t: 1, acct: "amy", term: "K2", res: "WRONG_PIN" })).toEqual({
      account: "amy",
      terminal: "K2",
      outcome: "fail",
    });
  });
});
