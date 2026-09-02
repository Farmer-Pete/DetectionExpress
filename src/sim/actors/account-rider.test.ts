import { describe, expect, it } from "vitest";
import { GAME_SECONDS_PER_TICK } from "../../game/tuning";
import type { AccountKioskReading } from "../endpoints/kiosk/internal";
import { distanceTable } from "../world/distance";
import type { Presence } from "../world/presence";
import { buildTimetable } from "../world/timetable";
import { world } from "../world/world";
import type { WorldEnv, WorldReading } from "../world-reading";
import {
  type AccountRiderConfig,
  createAccountRider,
  initialAccountRiderPresence,
} from "./account-rider";
import { createSchedule } from "./actor";

const env: WorldEnv = {
  world,
  distances: distanceTable(world),
  timetable: buildTimetable(world),
};

/** A kiosk payload, narrowed off the discriminated union. */
function kioskOf(reading: WorldReading): AccountKioskReading {
  if (reading.sensor !== "kiosk") {
    throw new Error(`expected a kiosk reading, got "${reading.sensor}".`);
  }
  return reading.reading;
}

/** Step one account rider to dormancy, collecting its kiosk readings and presences. */
function runAccountRider(config: AccountRiderConfig) {
  const schedule = createSchedule({ actors: [createAccountRider(config)], env, runSeed: 1 });
  const readings: AccountKioskReading[] = [];
  const presences: Presence[] = [];
  for (let tick = 0; tick < 500; tick++) {
    const step = schedule.advanceTo(tick + 1);
    for (const timed of step.readings) {
      readings.push(kioskOf(timed.reading));
    }
    const presence = step.presences.get(config.id);
    if (presence !== undefined) {
      presences.push(presence);
    }
    if (schedule.activeIds().length === 0 && tick >= config.startTick) {
      break;
    }
  }
  return { readings, presences, activeAfter: schedule.activeIds().length };
}

const BASE: AccountRiderConfig = {
  id: "A000042",
  account: "river.k",
  station: "har",
  terminal: "K1",
  startTick: 3,
  dwellTicks: 4,
};

describe("createAccountRider", () => {
  it("signs in benignly: exactly one kiosk success reading at its station terminal", () => {
    const { readings } = runAccountRider(BASE);
    expect(readings).toHaveLength(1);
    const signin = readings[0];
    expect(signin?.outcome).toBe("success");
    expect(signin?.account).toBe("river.k");
    expect(signin?.station).toBe("har");
    expect(signin?.terminal).toBe("K1");
    expect(signin?.ts).toBe(BASE.startTick * GAME_SECONDS_PER_TICK);
  });

  it("with no fumble config, never fails a PIN: every reading is a success", () => {
    const { readings } = runAccountRider(BASE);
    expect(readings.length).toBeGreaterThan(0);
    for (const reading of readings) {
      expect(reading.outcome).toBe("success");
    }
  });

  it("stands at the station while at the kiosk, then leaves and despawns", () => {
    const { presences, activeAfter } = runAccountRider(BASE);
    const atKiosk = presences[0];
    expect(atKiosk?.kind).toBe("at");
    if (atKiosk?.kind === "at") {
      expect(atKiosk.node).toBe("har");
      expect(atKiosk.fromTick).toBe(BASE.startTick);
      expect(atKiosk.untilTick).toBe(BASE.startTick + BASE.dwellTicks);
    }
    // After the dwell it walks off and is evicted from the schedule.
    expect(activeAfter).toBe(0);
  });

  it("is deterministic: a seed reproduces the same sign-in", () => {
    const run = () => runAccountRider(BASE).readings;
    expect(run()).toEqual(run());
  });

  it("signs in at whichever station and terminal it is given", () => {
    const { readings } = runAccountRider({ ...BASE, station: "cen", terminal: "K2" });
    expect(readings[0]?.station).toBe("cen");
    expect(readings[0]?.terminal).toBe("K2");
  });
});

describe("createAccountRider fumbles", () => {
  it("emits fail, fail, then success at the sign-in tick, in that order", () => {
    const { readings } = runAccountRider({ ...BASE, fumbleFails: 2 });
    expect(readings.map((r) => r.outcome)).toEqual(["fail", "fail", "success"]);
    // All three fire at the one sign-in tick.
    const signinTs = BASE.startTick * GAME_SECONDS_PER_TICK;
    for (const reading of readings) {
      expect(reading.ts).toBe(signinTs);
      expect(reading.account).toBe("river.k");
      expect(reading.terminal).toBe("K1");
    }
  });

  it("emits one fail then a success for fumbleFails: 1", () => {
    const { readings } = runAccountRider({ ...BASE, fumbleFails: 1 });
    expect(readings.map((r) => r.outcome)).toEqual(["fail", "success"]);
  });

  it("reproduces the omitted stream exactly when fumbleFails is 0", () => {
    const omitted = runAccountRider(BASE).readings;
    const zero = runAccountRider({ ...BASE, fumbleFails: 0 }).readings;
    expect(zero).toEqual(omitted);
    expect(omitted).toHaveLength(1);
    expect(omitted[0]?.outcome).toBe("success");
  });
});

describe("createAccountRider destination (GH124-PLAN.md Checkpoint 4 Part 1)", () => {
  // FEASIBILITY: an account rider only ever visits a kiosk and leaves — it has no
  // metro trip or chosen destination at all, unlike `createWorldRider`. It must never
  // emit a `destination` delta, so its `ActorView.destination` stays undefined for
  // its whole life. It is not a trip kind, so the place dialog never labels it
  // "waiting for a train"; `actorsAtNode` gives it "signing in" instead, since it is
  // at a kiosk (see `place-view.ts`'s `activityFor`).
  it("never reports a destination, at sign-in or while lingering at the kiosk", () => {
    const schedule = createSchedule({ actors: [createAccountRider(BASE)], env, runSeed: 1 });
    for (let tick = 0; tick < 500; tick++) {
      const step = schedule.advanceTo(tick + 1);
      expect(step.destinations.has(BASE.id)).toBe(false);
    }
  });
});

describe("initialAccountRiderPresence", () => {
  it("places a fresh account rider at its station until its first tick", () => {
    expect(initialAccountRiderPresence("mkt", 12)).toEqual({
      kind: "at",
      node: "mkt",
      fromTick: 12,
      untilTick: 12,
    });
  });
});
