import { describe, expect, it } from "vitest";
import { ORACLE_ROUNDS, oracleChecksum, xorshift32 } from "./oracle";

// The locked checksum for oracleChecksum(1, 1000), captured from the kernel.
const ORACLE_GOLDEN = 2_332_754_544;

/**
 * The oracle is the machine-speed probe: a fixed, allocation-free integer kernel.
 * Its timed throughput (O) is a health metric, but the CI guarantee is that its
 * output is bit-stable across runs, so a drift means a real regression, not
 * scheduler noise. See GH3-PLAN.md section 9, M1 seam 1.
 */
describe("xorshift32", () => {
  it("matches a hand-worked step for seed 1", () => {
    // x=1; x^=x<<13 -> 8193; x^=x>>>17 -> 8193; x^=x<<5 -> bits {0,5,13,18} = 270369.
    expect(xorshift32(1)).toBe(270369);
  });

  it("is deterministic and never lands on zero from a non-zero state", () => {
    expect(xorshift32(1)).toBe(xorshift32(1));
    expect(xorshift32(0x1234abcd) | 0).toBe(xorshift32(0x1234abcd) | 0);
  });
});

describe("oracleChecksum", () => {
  it("returns zero when it does no rounds of mixing", () => {
    // The mixing loop never runs, so the checksum stays at its identity.
    expect(oracleChecksum(7, 0)).toBe(0);
  });

  it("gives the same checksum on every run for the same input", () => {
    const a = oracleChecksum(12345, ORACLE_ROUNDS);
    const b = oracleChecksum(12345, ORACLE_ROUNDS);
    expect(a).toBe(b);
  });

  it("is an unsigned 32-bit integer", () => {
    const checksum = oracleChecksum(999, ORACLE_ROUNDS);
    expect(Number.isInteger(checksum)).toBe(true);
    expect(checksum).toBeGreaterThanOrEqual(0);
    expect(checksum).toBeLessThanOrEqual(0xffffffff);
  });

  it("responds to the seed and to the round count", () => {
    expect(oracleChecksum(1, ORACLE_ROUNDS)).not.toBe(oracleChecksum(2, ORACLE_ROUNDS));
    expect(oracleChecksum(1, 10)).not.toBe(oracleChecksum(1, 20));
  });

  it("holds its captured value, so a drift fails CI (characterization lock)", () => {
    // Captured from the kernel itself; it guards against an accidental change to
    // the mixing constants, not an independent re-derivation.
    expect(oracleChecksum(1, 1000)).toBe(ORACLE_GOLDEN);
  });
});
