import { describe, expect, it } from "bun:test";
import { OMEGA, SERVICE_DEN } from "../tuning";
import { quantizeServiceRate, serviceRateForCode } from "./quantize";

/**
 * The quantizer turns a measured float rate into a reduced rational {num, den}
 * the integer service governor (M2) charges without float drift. These tests pin
 * the exactness, the gcd reduction, and the safe-integer guard. Expected values
 * are worked by hand from SERVICE_DEN = 1_000_000, not recomputed the way the
 * code does.
 */
describe("quantizeServiceRate", () => {
  it("reduces a half to 1/2 exactly", () => {
    // 0.5 * 1_000_000 = 500_000; gcd(500_000, 1_000_000) = 500_000.
    expect(quantizeServiceRate(0.5)).toEqual({ num: 1, den: 2 });
  });

  it("reduces a whole rate above one to n/1", () => {
    // 20 * 1_000_000 = 20_000_000; gcd(20_000_000, 1_000_000) = 1_000_000.
    expect(quantizeServiceRate(20)).toEqual({ num: 20, den: 1 });
  });

  it("keeps a unit rate at 1/1", () => {
    expect(quantizeServiceRate(1)).toEqual({ num: 1, den: 1 });
  });

  it("reduces an awkward value by its gcd", () => {
    // 0.36 * 1_000_000 = 360_000; gcd(360_000, 1_000_000) = 40_000 -> 9/25.
    expect(quantizeServiceRate(0.36)).toEqual({ num: 9, den: 25 });
  });

  it("rounds a value with no exact denominator to the nearest num", () => {
    // 1/3 * 1_000_000 = 333_333.33 -> rounds to 333_333; gcd(333_333, 1_000_000) = 1.
    expect(quantizeServiceRate(1 / 3)).toEqual({ num: 333_333, den: SERVICE_DEN });
  });

  it("keeps num at least one for a tiny positive rate", () => {
    // 1e-9 * 1_000_000 = 0.001 -> rounds to 0, floored up to 1.
    expect(quantizeServiceRate(1e-9)).toEqual({ num: 1, den: SERVICE_DEN });
  });

  it("clamps num to the safe-integer bound and stays reducible", () => {
    const rate = quantizeServiceRate(Number.MAX_SAFE_INTEGER);
    expect(rate.num).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER - rate.den);
    expect(Number.isSafeInteger(rate.num)).toBe(true);
    expect(Number.isSafeInteger(rate.den)).toBe(true);
  });

  it("rejects a non-finite rate", () => {
    expect(() => quantizeServiceRate(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => quantizeServiceRate(Number.NaN)).toThrow();
  });

  it("rejects a non-positive rate", () => {
    expect(() => quantizeServiceRate(0)).toThrow();
    expect(() => quantizeServiceRate(-1)).toThrow();
  });
});

describe("serviceRateForCode", () => {
  it("scales the code speed by OMEGA before quantizing", () => {
    // The composed helper must equal quantizing codePerAnchor * OMEGA directly.
    expect(serviceRateForCode(0.5)).toEqual(quantizeServiceRate(0.5 * OMEGA));
    expect(serviceRateForCode(20)).toEqual(quantizeServiceRate(20 * OMEGA));
  });
});
