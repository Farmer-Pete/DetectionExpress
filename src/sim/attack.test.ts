import { describe, expect, it } from "vitest";
import { assertValidThreshold } from "./attack";

describe("assertValidThreshold", () => {
  it("accepts a positive integer", () => {
    expect(() => assertValidThreshold({ id: 1, threshold: 5 })).not.toThrow();
  });

  it("names the failure mode for zero", () => {
    expect(() => assertValidThreshold({ id: 1, threshold: 0 })).toThrow(
      /Attack 1's threshold must be a positive integer, got 0/,
    );
  });

  it("rejects a negative threshold", () => {
    expect(() => assertValidThreshold({ id: 2, threshold: -3 })).toThrow(/positive integer/);
  });

  it("rejects a fractional threshold", () => {
    expect(() => assertValidThreshold({ id: 3, threshold: 2.5 })).toThrow(/positive integer/);
  });

  it("rejects NaN", () => {
    expect(() => assertValidThreshold({ id: 4, threshold: Number.NaN })).toThrow(
      /positive integer/,
    );
  });
});
