import { describe, expect, it } from "vitest";
import { ATTACK_ACCOUNT_NAMESPACE, BENIGN_ACCOUNT_NAMESPACE } from "./account-namespace";

// GH126-PLAN.md M2a item 4, seam 11: two disjoint account ranges, fixed
// independently of any run's own seed, so a benign fumble burst can never target
// an active attack's victim account, by construction.
describe("account namespace partition", () => {
  it("reserves non-empty benign and attack ranges", () => {
    expect(BENIGN_ACCOUNT_NAMESPACE.length).toBeGreaterThan(0);
    expect(ATTACK_ACCOUNT_NAMESPACE.length).toBeGreaterThan(0);
  });

  it("keeps the two ranges disjoint", () => {
    const benign = new Set(BENIGN_ACCOUNT_NAMESPACE);
    for (const account of ATTACK_ACCOUNT_NAMESPACE) {
      expect(benign.has(account)).toBe(false);
    }
  });

  it("holds distinct accounts within each range", () => {
    expect(new Set(BENIGN_ACCOUNT_NAMESPACE).size).toBe(BENIGN_ACCOUNT_NAMESPACE.length);
    expect(new Set(ATTACK_ACCOUNT_NAMESPACE).size).toBe(ATTACK_ACCOUNT_NAMESPACE.length);
  });
});
