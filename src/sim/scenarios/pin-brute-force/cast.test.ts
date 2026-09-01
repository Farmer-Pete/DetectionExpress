import { randomLcg } from "d3-random";
import { describe, expect, it } from "vitest";
import { KIOSK_TERMINALS } from "../../endpoints/kiosk/internal";
import { world } from "../../world/world";
import {
  assembleAttacker,
  type BenignVisit,
  budgetFumbles,
  buildIdentityPools,
  buildPartitionedIdentityPools,
} from "./cast";
import { SCAN_WINDOW_TICKS } from "./tuning";

describe("buildIdentityPools", () => {
  it("is deterministic for a seed", () => {
    const a = buildIdentityPools(randomLcg(7), world, 40);
    const b = buildIdentityPools(randomLcg(7), world, 40);
    expect(a).toEqual(b);
  });

  it("mints distinct account names and the world's stations and kiosk terminals", () => {
    const pools = buildIdentityPools(randomLcg(7), world, 40);
    expect(pools.accounts).toHaveLength(40);
    expect(new Set(pools.accounts).size).toBe(40);
    expect(pools.stations).toEqual(world.stations.map((s) => s.id));
    expect(pools.terminals).toEqual(KIOSK_TERMINALS);
  });

  it("draws a different account pool for a different seed", () => {
    const a = buildIdentityPools(randomLcg(7), world, 40).accounts;
    const b = buildIdentityPools(randomLcg(8), world, 40).accounts;
    expect(a).not.toEqual(b);
  });
});

// GH42-PLAN.md "Composable streams": entity disjointness is set at generation. A
// partition slices a fixed, seed-independent namespace, so two runs given
// different partitions never share an account, no matter what seed generated
// each run.
describe("buildPartitionedIdentityPools", () => {
  it("draws disjoint account slices for different partitions, independent of any run seed", () => {
    const p0 = buildPartitionedIdentityPools(world, 40, 0).accounts;
    const p1 = buildPartitionedIdentityPools(world, 40, 1).accounts;
    expect(p0).toHaveLength(40);
    expect(p1).toHaveLength(40);
    expect(new Set(p0).size).toBe(40);
    expect(new Set(p1).size).toBe(40);
    const overlap = p0.filter((account) => p1.includes(account));
    expect(overlap).toEqual([]);
  });

  it("is deterministic: the same partition always yields the same slice", () => {
    const a = buildPartitionedIdentityPools(world, 40, 2);
    const b = buildPartitionedIdentityPools(world, 40, 2);
    expect(a).toEqual(b);
  });

  it("carries the same world stations and kiosk terminals as buildIdentityPools", () => {
    const pools = buildPartitionedIdentityPools(world, 40, 0);
    expect(pools.stations).toEqual(world.stations.map((s) => s.id));
    expect(pools.terminals).toEqual(KIOSK_TERMINALS);
  });

  it("rejects a negative or out-of-range partition", () => {
    expect(() => buildPartitionedIdentityPools(world, 40, -1)).toThrow(/partition/);
    expect(() => buildPartitionedIdentityPools(world, 40, 999)).toThrow(/partition/);
  });

  it("keeps partitions disjoint even when two runs request different account counts", () => {
    // GH42 code review: the partition slice rides a fixed per-partition block, not the
    // caller's accountCount, so a wide run in one partition and a narrow run in the next
    // never overlap. Before the fix, count 40 partition 0 ([0,40)) and count 20 partition
    // 1 ([20,40)) collided.
    const wide = buildPartitionedIdentityPools(world, 40, 0).accounts;
    const narrow = buildPartitionedIdentityPools(world, 20, 1).accounts;
    expect(wide).toHaveLength(40);
    expect(narrow).toHaveLength(20);
    const overlap = wide.filter((account) => narrow.includes(account));
    expect(overlap).toEqual([]);
  });

  it("rejects an accountCount wider than the per-partition block", () => {
    expect(() => buildPartitionedIdentityPools(world, 65, 0)).toThrow(
      /ACCOUNTS_PER_PARTITION|accountCount|\[0,/,
    );
  });

  it("rejects a NaN, negative, or fractional accountCount", () => {
    expect(() => buildPartitionedIdentityPools(world, Number.NaN, 0)).toThrow(/accountCount/);
    expect(() => buildPartitionedIdentityPools(world, -1, 0)).toThrow(/accountCount/);
    expect(() => buildPartitionedIdentityPools(world, 1.5, 0)).toThrow(/accountCount/);
  });
});

describe("budgetFumbles", () => {
  /** Many visits for one account, all inside one 150-tick bucket. */
  function oneAccountBucket(account: string, count: number, bucketStart: number): BenignVisit[] {
    return Array.from({ length: count }, (_v, i) => ({
      account,
      tick: bucketStart + (i % SCAN_WINDOW_TICKS),
    }));
  }

  it("never lets an account exceed 2 fails in a single 150-tick bucket", () => {
    const visits = oneAccountBucket("river.k", 60, 0);
    const counts = budgetFumbles(visits, new Set(), randomLcg(3));
    const total = counts.reduce((sum: number, c) => sum + c, 0);
    expect(total).toBeLessThanOrEqual(2);
  });

  it("allows up to 2 fails in each of two adjacent buckets", () => {
    const first = oneAccountBucket("river.k", 60, 0);
    const second = oneAccountBucket("river.k", 60, SCAN_WINDOW_TICKS);
    const counts = budgetFumbles([...first, ...second], new Set(), randomLcg(9));
    const firstTotal = counts.slice(0, first.length).reduce((s: number, c) => s + c, 0);
    const secondTotal = counts.slice(first.length).reduce((s: number, c) => s + c, 0);
    expect(firstTotal).toBeLessThanOrEqual(2);
    expect(secondTotal).toBeLessThanOrEqual(2);
  });

  it("gives victims zero fumbles", () => {
    const visits = oneAccountBucket("victim.v", 200, 0);
    const counts = budgetFumbles(visits, new Set(["victim.v"]), randomLcg(1));
    expect(counts.every((c) => c === 0)).toBe(true);
  });

  it("is deterministic for a seed", () => {
    const visits = oneAccountBucket("river.k", 40, 0);
    const a = budgetFumbles(visits, new Set(), randomLcg(5));
    const b = budgetFumbles(visits, new Set(), randomLcg(5));
    expect(a).toEqual(b);
  });

  it("keeps at most 4 fails in a rolling window straddling a bucket boundary", () => {
    // The adversarial case: fumbles crowd the end of one bucket and the start of the
    // next, both within one rolling 150-tick window. Each fixed bucket caps at 2, so
    // the rolling window sees at most 4 — below the threshold of 5. Ticks 149 and 150
    // sit in adjacent buckets one tick apart.
    const lateBucketZero: BenignVisit[] = Array.from({ length: 20 }, () => ({
      account: "river.k",
      tick: SCAN_WINDOW_TICKS - 1,
    }));
    const earlyBucketOne: BenignVisit[] = Array.from({ length: 20 }, () => ({
      account: "river.k",
      tick: SCAN_WINDOW_TICKS,
    }));
    const counts = budgetFumbles([...lateBucketZero, ...earlyBucketOne], new Set(), randomLcg(2));
    const bucketZeroTotal = counts
      .slice(0, lateBucketZero.length)
      .reduce((s: number, c) => s + c, 0);
    const bucketOneTotal = counts.slice(lateBucketZero.length).reduce((s: number, c) => s + c, 0);
    expect(bucketZeroTotal).toBeLessThanOrEqual(2);
    expect(bucketOneTotal).toBeLessThanOrEqual(2);
    expect(bucketZeroTotal + bucketOneTotal).toBeLessThanOrEqual(4);
  });
});

describe("assembleAttacker", () => {
  it("labels each attacker actor with its attack id, covering exactly the attackers", () => {
    const specs = [
      {
        id: "X1",
        attackId: 1,
        account: "a.a",
        station: "har",
        terminal: "K1",
        failTimestamps: [60, 62, 64, 66, 68],
      },
      {
        id: "X2",
        attackId: 2,
        account: "b.b",
        station: "cen",
        terminal: "K2",
        failTimestamps: [80, 82, 84, 86, 88],
      },
    ];
    const labels = new Map(specs.map((spec) => assembleAttacker(spec).label));
    expect([...labels.entries()]).toEqual([
      ["X1", 1],
      ["X2", 2],
    ]);
    expect(labels.size).toBe(specs.length);
  });
});
