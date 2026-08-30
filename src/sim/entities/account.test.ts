import { randomLcg } from "d3-random";
import { describe, expect, it } from "vitest";
import { buildAccounts } from "./account";

describe("buildAccounts", () => {
  it("is deterministic for a seed", () => {
    expect(buildAccounts(8, randomLcg(7))).toEqual(buildAccounts(8, randomLcg(7)));
  });

  it("returns the requested count of distinct account names", () => {
    const accounts = buildAccounts(12, randomLcg(99));
    expect(accounts).toHaveLength(12);
    expect(new Set(accounts.map((account) => account.name)).size).toBe(12);
  });

  it("mints account-shaped usernames (a stem, a dot, and a letter)", () => {
    for (const account of buildAccounts(20, randomLcg(3))) {
      expect(account.name).toMatch(/^[a-z]+\.[a-z]$/);
    }
  });

  it("differs across seeds", () => {
    const a = buildAccounts(12, randomLcg(1)).map((account) => account.name);
    const b = buildAccounts(12, randomLcg(2)).map((account) => account.name);
    expect(a).not.toEqual(b);
  });

  it("rejects a count that is not a finite non-negative integer", () => {
    expect(() => buildAccounts(Number.POSITIVE_INFINITY, randomLcg(1))).toThrow(
      /non-negative integer/,
    );
    expect(() => buildAccounts(-1, randomLcg(1))).toThrow(/non-negative integer/);
    expect(() => buildAccounts(3.5, randomLcg(1))).toThrow(/non-negative integer/);
  });
});
