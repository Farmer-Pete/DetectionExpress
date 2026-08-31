import { describe, expect, it } from "vitest";
import { DRAIN_GAP_TICKS, LEVEL_SEED } from "../../../game/tuning";
import type { RawGatekeepGate } from "../../endpoints/fare-gate/gatekeep";
import { buildSchedule } from "../../schedule";
import { buildFareGateRun } from "./run";
import { raw, tickOf } from "./test-helpers";

describe("buildFareGateRun: determinism", () => {
  it("replays the same run for the same seed", () => {
    const a = buildFareGateRun(LEVEL_SEED);
    const b = buildFareGateRun(LEVEL_SEED);
    expect(a.events).toEqual(b.events);
    expect(a.attacks).toEqual(b.attacks);
    expect(a.checkpoints).toEqual(b.checkpoints);
  });

  it("gives two different seeds two different runs", () => {
    const a = buildFareGateRun(LEVEL_SEED);
    const b = buildFareGateRun(LEVEL_SEED + 1);
    expect(a.events).not.toEqual(b.events);
  });
});

describe("buildFareGateRun: coherence", () => {
  const run = buildFareGateRun(LEVEL_SEED);

  it("gives every event ids 0..n-1 in sorted order and returns no attacks", () => {
    run.events.forEach((ev, i) => {
      expect(ev.id).toBe(i);
      expect(ev.endpoint).toBe("gatekeep-turnkey");
    });
    expect(run.attacks).toEqual([]);
  });

  it("emits every event in non-decreasing ts order", () => {
    let prev = Number.NEGATIVE_INFINITY;
    for (const ev of run.events) {
      expect(ev.ts).toBeGreaterThanOrEqual(prev);
      prev = ev.ts;
    }
  });

  it("has each card tap in exactly once, then out exactly once", () => {
    const byCard = new Map<string, RawGatekeepGate[]>();
    for (const ev of run.events) {
      const record = raw(ev);
      const list = byCard.get(record.MEDIA_SERIAL) ?? [];
      list.push(record);
      byCard.set(record.MEDIA_SERIAL, list);
    }
    expect(byCard.size).toBeGreaterThan(0);
    for (const [, records] of byCard) {
      expect(records).toHaveLength(2);
      expect(records[0]?.DIRECTION).toBe("ENTRY");
      expect(records[1]?.DIRECTION).toBe("EXIT");
    }
  });

  it("keeps every balance a whole, non-negative amount", () => {
    for (const ev of run.events) {
      const record = raw(ev);
      expect(Number.isInteger(record.STORED_VALUE)).toBe(true);
      expect(record.STORED_VALUE).toBeGreaterThanOrEqual(0);
    }
  });

  it("leaves the balance unchanged on the out, matching the balance the in reported", () => {
    const byCard = new Map<string, RawGatekeepGate[]>();
    for (const ev of run.events) {
      const record = raw(ev);
      const list = byCard.get(record.MEDIA_SERIAL) ?? [];
      list.push(record);
      byCard.set(record.MEDIA_SERIAL, list);
    }
    expect(byCard.size).toBeGreaterThan(0);
    for (const [, [entry, exit]] of byCard) {
      expect(exit?.STORED_VALUE).toBe(entry?.STORED_VALUE); // the out does not charge
    }
    // Every rider starts at the same world-maximum balance, but rides a
    // different, seeded-random destination, so the fare — and the balance
    // the in reports after paying it — varies rider to rider. At least two
    // distinct post-charge balances proves the fare is actually distance-priced,
    // not a flat deduction.
    const postChargeBalances = new Set([...byCard.values()].map(([entry]) => entry?.STORED_VALUE));
    expect(postChargeBalances.size).toBeGreaterThan(1);
  });

  it("permits every result, since every rider affords its one trip", () => {
    for (const ev of run.events) {
      expect(raw(ev).GATE_RESULT).toBe("PERMIT");
    }
  });

  it("closes every in with its out inside the run's own events, all results ok", () => {
    const entries = run.events.filter((ev) => raw(ev).DIRECTION === "ENTRY");
    const exits = run.events.filter((ev) => raw(ev).DIRECTION === "EXIT");
    expect(exits.length).toBe(entries.length);
    const exitCards = new Set(exits.map((ev) => raw(ev).MEDIA_SERIAL));
    for (const entry of entries) {
      expect(exitCards.has(raw(entry).MEDIA_SERIAL)).toBe(true);
    }
  });
});

describe("buildFareGateRun: final deadline", () => {
  it("sets the last checkpoint to lastEventTick + 1 + DRAIN_GAP_TICKS", () => {
    const run = buildFareGateRun(LEVEL_SEED);
    const lastEventTick = Math.max(...run.events.map(tickOf));
    const lastCheckpoint = run.checkpoints[run.checkpoints.length - 1];
    expect(lastCheckpoint?.atTick).toBe(lastEventTick + 1 + DRAIN_GAP_TICKS);
  });

  it("keeps every checkpoint strictly ascending, with the wave index unchanged on the last one", () => {
    const run = buildFareGateRun(LEVEL_SEED);
    let prev = -1;
    run.checkpoints.forEach((cp) => {
      expect(cp.atTick).toBeGreaterThan(prev);
      prev = cp.atTick;
    });
    expect(run.checkpoints[run.checkpoints.length - 1]?.clearsThroughWave).toBe(
      run.checkpoints.length - 1,
    );
  });

  it("leaves every event strictly before the final deadline", () => {
    const run = buildFareGateRun(LEVEL_SEED);
    const deadlineTicks = run.checkpoints[run.checkpoints.length - 1]?.atTick ?? 0;
    for (const ev of run.events) {
      expect(tickOf(ev)).toBeLessThan(deadlineTicks);
    }
  });
});

describe("buildFareGateRun: waves (GH38-PLAN.md Part 1)", () => {
  it("carries the schedule's waves through into the generated run unchanged", () => {
    const run = buildFareGateRun(LEVEL_SEED);
    expect(run.waves).toEqual(buildSchedule().waves);
  });
});
