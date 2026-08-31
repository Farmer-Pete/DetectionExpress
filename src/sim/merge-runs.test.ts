import { describe, expect, it } from "vitest";
import type { Attack } from "./attack";
import type { PipeEvent } from "./event";
import { mergeRuns } from "./merge-runs";
import type { Checkpoint, GeneratedRun, Wave } from "./scenario";

const REASON = "pin_brute_force";

const WAVES: Wave[] = [{ startTick: 120, durationTicks: 240, eventsPerTick: 5 }];
const CHECKPOINTS: Checkpoint[] = [{ atTick: 405, clearsThroughWave: 0 }];

/** A shared schedule every fixture run carries, mirroring buildSchedule()'s contract:
 * every scenario's run shares the identical wave schedule and checkpoints. */
function schedule(): { waves: Wave[]; checkpoints: Checkpoint[] } {
  return { waves: WAVES.map((w) => ({ ...w })), checkpoints: CHECKPOINTS.map((c) => ({ ...c })) };
}

function ev(id: number, ts: number): PipeEvent {
  return { id, ts, endpoint: "kiosk-v1", payload: { id } };
}

function attack(id: number, entity: string, eventIds: number[], threshold = 2): Attack {
  return { id, entity, reason: REASON, window: { startTs: 0, endTs: 1000 }, eventIds, threshold };
}

function run(events: PipeEvent[], attacks: Attack[]): GeneratedRun {
  const { waves, checkpoints } = schedule();
  return { events, attacks, checkpoints, waves };
}

describe("mergeRuns", () => {
  it("keeps one copy of the shared schedule rather than concatenating it", () => {
    const a = run([ev(0, 10), ev(1, 30)], [attack(1, "a-victim", [1])]);
    const b = run([ev(0, 20), ev(1, 40)], [attack(1, "b-victim", [0])]);
    const merged = mergeRuns([a, b]);
    expect(merged.waves).toEqual(WAVES);
    expect(merged.checkpoints).toEqual(CHECKPOINTS);
  });

  it("renumbers events in time order across runs, with no gaps", () => {
    const a = run([ev(0, 10), ev(1, 30)], [attack(1, "a-victim", [1])]);
    const b = run([ev(0, 20), ev(1, 40)], [attack(1, "b-victim", [0])]);
    const merged = mergeRuns([a, b]);
    // Time order: a@10, b@20, a@30, b@40 -> new ids 0,1,2,3.
    expect(merged.events.map((e) => e.ts)).toEqual([10, 20, 30, 40]);
    merged.events.forEach((e, i) => {
      expect(e.id).toBe(i);
    });
  });

  it("remaps each Attack's id and eventIds to the new numbering, and gives every Attack a unique id", () => {
    const a = run([ev(0, 10), ev(1, 30)], [attack(1, "a-victim", [1])]); // cites its own ev ts=30
    const b = run([ev(0, 20), ev(1, 40)], [attack(1, "b-victim", [0])]); // cites its own ev ts=20
    const merged = mergeRuns([a, b]);
    expect(merged.attacks).toHaveLength(2);
    const ids = merged.attacks.map((att) => att.id);
    expect(new Set(ids).size).toBe(2); // both runs used Attack id 1; must not collide

    const byEntity = new Map(merged.attacks.map((att) => [att.entity, att]));
    const aAttack = byEntity.get("a-victim");
    const bAttack = byEntity.get("b-victim");
    expect(aAttack).toBeDefined();
    expect(bAttack).toBeDefined();
    // a's cited event (its own old id 1, ts=30) is merged event id 2.
    expect(aAttack?.eventIds).toEqual([2]);
    // b's cited event (its own old id 0, ts=20) is merged event id 1.
    expect(bAttack?.eventIds).toEqual([1]);
  });

  it("throws when the runs' wave schedules differ", () => {
    const a = run([ev(0, 10)], []);
    const b: GeneratedRun = {
      events: [ev(0, 20)],
      attacks: [],
      waves: [{ startTick: 999, durationTicks: 1, eventsPerTick: 1 }],
      checkpoints: CHECKPOINTS,
    };
    expect(() => mergeRuns([a, b])).toThrow(/wave schedule/);
  });

  it("throws when two runs' Attacks share an entity (partitioning failed)", () => {
    const a = run([ev(0, 10)], [attack(1, "shared", [0])]);
    const b = run([ev(0, 20)], [attack(1, "shared", [0])]);
    expect(() => mergeRuns([a, b])).toThrow(/disjoint/);
  });

  it("throws when an Attack cites an event id outside its own run", () => {
    const a = run([ev(0, 10)], [attack(1, "a-victim", [99])]); // no event 99 in this run
    const b = run([ev(0, 20)], [attack(1, "b-victim", [0])]);
    expect(() => mergeRuns([a, b])).toThrow(/not among that run's own events/);
  });

  it("throws when two Attacks would own the same merged event id", () => {
    // A malformed single run: two Attacks both cite event 0. Not something a real
    // scenario's own separability proof would allow, but the merge must still guard it.
    const a = run([ev(0, 10), ev(1, 20)], [attack(1, "x", [0]), attack(2, "y", [0])]);
    expect(() => mergeRuns([a])).toThrow(/same merged event id|two different Attacks/);
  });

  it("preserves each Attack's evidence count exactly (separability preserved)", () => {
    const a = run([ev(0, 10), ev(1, 20), ev(2, 30)], [attack(1, "a-victim", [0, 1, 2], 3)]);
    const b = run([ev(0, 40)], [attack(1, "b-victim", [0])]);
    const merged = mergeRuns([a, b]);
    const aAttack = merged.attacks.find((att) => att.entity === "a-victim");
    expect(aAttack?.eventIds).toHaveLength(3);
    expect(aAttack?.threshold).toBe(3);
  });

  it("requires at least one run", () => {
    expect(() => mergeRuns([])).toThrow(/at least one/);
  });
});
