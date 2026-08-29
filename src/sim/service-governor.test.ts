import { describe, expect, it } from "vitest";
import { makeGovernor, type ServiceRate } from "./service-governor";

/**
 * The service governor (M2 seam 4). Over N Events at a quantized rational
 * `serviceRate = num/den` records per tick, the total slept ticks must equal
 * `floor(N * den / num) = floor(N / serviceRate)` exactly, with no float drift,
 * for awkward rates, rates above and below one, and the maximum Event count. The
 * expected totals are the closed-form floor, an independent source of truth, not
 * the accumulator recomputed. It must also reject a non-finite or non-positive
 * rate. See GH3-PLAN.md sections 5.2 and 9 (M2 seam 4).
 */

/** Charge `n` Events and return the total ticks the governor slept. */
function totalSleep(rate: ServiceRate, n: number): number {
  const governor = makeGovernor(rate);
  let slept = 0;
  for (let i = 0; i < n; i++) {
    slept += governor.charge();
  }
  return slept;
}

/** The closed-form total: floor(n * den / num), computed with bigint to stay exact. */
function expectedSleep(rate: ServiceRate, n: number): number {
  return Number((BigInt(n) * BigInt(rate.den)) / BigInt(rate.num));
}

describe("makeGovernor charge", () => {
  const cases: Array<{ name: string; rate: ServiceRate; counts: number[] }> = [
    {
      name: "a whole rate above one (20/1)",
      rate: { num: 20, den: 1 },
      counts: [1, 19, 20, 21, 40, 199, 1000],
    },
    { name: "a unit rate (1/1)", rate: { num: 1, den: 1 }, counts: [0, 1, 2, 5, 1000] },
    { name: "a rate below one (1/2)", rate: { num: 1, den: 2 }, counts: [1, 2, 3, 7, 500] },
    {
      name: "an awkward reduced rate (9/25)",
      rate: { num: 9, den: 25 },
      counts: [1, 2, 9, 10, 25, 137, 5000],
    },
    {
      name: "a rate with no exact denominator (333333/1000000)",
      rate: { num: 333_333, den: 1_000_000 },
      counts: [1, 3, 4, 1000, 12345],
    },
  ];

  for (const { name, rate, counts } of cases) {
    it(`sleeps exactly floor(N/rate) for ${name}`, () => {
      for (const n of counts) {
        expect(totalSleep(rate, n)).toBe(expectedSleep(rate, n));
      }
    });
  }

  it("stays exact at a large Event count near the safe-integer bound", () => {
    // den close to the cap, num just above it, so a single charge lands acc + den
    // at the very edge of the safe range. Charging many Events must not overflow.
    const rate: ServiceRate = { num: 1_000_001, den: 1_000_000 };
    const n = 1_000_000;
    expect(totalSleep(rate, n)).toBe(expectedSleep(rate, n));
  });

  it("holds the invariant 0 <= acc < num between Events (no drift over a long run)", () => {
    // A prime-ish awkward rate run long: the running total must match the closed
    // form at every step, which can only hold if acc never drifts.
    const rate: ServiceRate = { num: 7, den: 3 };
    const governor = makeGovernor(rate);
    let slept = 0;
    for (let n = 1; n <= 2000; n++) {
      slept += governor.charge();
      expect(slept).toBe(expectedSleep(rate, n));
    }
  });
});

describe("makeGovernor charge equals the subtraction loop it replaced", () => {
  // The reference the integer-division `charge` must match exactly: drain `num`
  // from the accumulator one tick at a time. Both helpers carry `acc` so the test
  // can compare the final accumulator, not just the tick counts.
  function loopCharge(state: { acc: number }, num: number, den: number) {
    state.acc += den;
    let ticks = 0;
    while (state.acc >= num) {
      state.acc -= num;
      ticks += 1;
    }
    return ticks;
  }
  function divCharge(state: { acc: number }, num: number, den: number) {
    state.acc += den;
    const ticks = Math.floor(state.acc / num);
    state.acc -= ticks * num;
    return ticks;
  }

  const rates: ServiceRate[] = [
    { num: 1, den: 1 },
    { num: 20, den: 1 },
    { num: 500, den: 1 },
    { num: 1, den: 2 },
    { num: 9, den: 25 },
    { num: 7, den: 3 },
    { num: 333_333, den: 1_000_000 },
  ];

  it("matches the loop per charge, in final acc, and through the real governor", () => {
    for (const rate of rates) {
      const { num, den } = rate;
      const loop = { acc: 0 };
      const div = { acc: 0 };
      const governor = makeGovernor(rate);
      let loopTotal = 0;
      let realTotal = 0;
      for (let n = 1; n <= 3000; n++) {
        const loopTicks = loopCharge(loop, num, den);
        const divTicks = divCharge(div, num, den);
        const realTicks = governor.charge();
        expect(divTicks).toBe(loopTicks); // division equals the loop, per charge
        expect(realTicks).toBe(loopTicks); // the shipped governor equals the loop
        expect(div.acc).toBe(loop.acc); // and leaves the accumulator identical
        expect(div.acc).toBeLessThan(num); // invariant 0 <= acc < num holds
        loopTotal += loopTicks;
        realTotal += realTicks;
      }
      expect(realTotal).toBe(loopTotal); // identical total sleep over the whole run
    }
  });
});

describe("makeGovernor rejects a bad rate", () => {
  it("rejects a non-finite numerator or denominator", () => {
    expect(() => makeGovernor({ num: Number.POSITIVE_INFINITY, den: 1 })).toThrow();
    expect(() => makeGovernor({ num: 1, den: Number.NaN })).toThrow();
  });

  it("rejects a non-positive rate", () => {
    expect(() => makeGovernor({ num: 0, den: 1 })).toThrow();
    expect(() => makeGovernor({ num: -1, den: 1 })).toThrow();
    expect(() => makeGovernor({ num: 1, den: 0 })).toThrow();
  });

  it("rejects a non-integer rate", () => {
    expect(() => makeGovernor({ num: 1.5, den: 1 })).toThrow();
    expect(() => makeGovernor({ num: 2, den: 1.5 })).toThrow();
  });

  it("rejects a numerator that would overflow the safe-integer bound", () => {
    expect(() => makeGovernor({ num: Number.MAX_SAFE_INTEGER, den: 1_000_000 })).toThrow();
  });
});
