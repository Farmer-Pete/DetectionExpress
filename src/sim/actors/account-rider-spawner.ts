/**
 * The account-rider population spawner: a deterministic, seeded source of transient
 * account riders. The live run is perpetual, so a small cast is kept without unbounded
 * growth. On each tick it admits a fresh account rider whenever the live count is below
 * the target and an arrival is due, minting a new id per birth, drawing an account from
 * a seeded pool, and picking a station and kiosk terminal to sign in at.
 *
 * All randomness comes from one seeded stream derived from the run seed, so the whole
 * admission sequence replays for a seed on one machine. No wall clock, no React
 * (ARCHITECTURE rule 8, ADR-0007). It mirrors the rider and staff spawners: a seeded
 * arrival process capped at a target, not the prototype's timer.
 */
import { randomLcg } from "d3-random";
import {
  ACCOUNT_ARRIVAL_MAX_TICKS,
  ACCOUNT_ARRIVAL_MIN_TICKS,
  ACCOUNT_DWELL_TICKS,
  ACCOUNT_POOL,
} from "../../game/tuning";
import { KIOSK_TERMINALS } from "../endpoints/kiosk/internal";
import { type Account, buildAccounts } from "../entities/account";
import type { World } from "../world/world";
import type { WorldEnv, WorldReading } from "../world-reading";
import {
  type AccountRiderConfig,
  createAccountRider,
  initialAccountRiderPresence,
} from "./account-rider";
import { type Admission, actorSeedHash } from "./actor";
import { seededArrivalProcess } from "./arrival-process";

/** Everything the spawner needs. `seed` is the run seed; the spawner derives its own stream. */
export interface AccountRiderSpawnerConfig {
  seed: number;
  world: World;
  /** The steady concurrent account-rider count. The spawner never admits above it. */
  target: number;
}

/** A seeded account-rider source the engine ticks once per sim tick. */
export interface AccountRiderSpawner {
  /**
   * The admissions due at `nowTick` given the current live account-rider count. Zero or
   * more, bounded so `liveAccountRiders + result.length <= target`. Deterministic for
   * the seed and the sequence of `(nowTick, liveAccountRiders)` inputs.
   */
  tick(nowTick: number, liveAccountRiders: number): readonly Admission<WorldReading, WorldEnv>[];
}

export function createAccountRiderSpawner(config: AccountRiderSpawnerConfig): AccountRiderSpawner {
  // A distinct seeded stream, keyed off the run seed but separate from every actor's,
  // so the spawn cadence never shares a stream with an account rider's own draws.
  const rng = randomLcg(actorSeedHash(config.seed, "account-rider-spawner"));
  const accounts = buildAccounts(ACCOUNT_POOL, rng);
  const stations = config.world.stations;

  let births = 0;

  const pick = <T>(items: readonly T[]): T | undefined => items[Math.floor(rng() * items.length)];

  const makeAdmission = (atTick: number): Admission<WorldReading, WorldEnv> => {
    const id = `A${String(births++).padStart(6, "0")}`;
    const account: Account = pick(accounts) ?? { name: "rider.x" };
    const station = pick(stations)?.id ?? stations[0]?.id ?? "cen";
    const terminal = pick(KIOSK_TERMINALS) ?? "K1";
    const riderConfig: AccountRiderConfig = {
      id,
      account: account.name,
      station,
      terminal,
      startTick: atTick,
      dwellTicks: ACCOUNT_DWELL_TICKS,
    };
    return {
      actor: createAccountRider(riderConfig),
      kind: "account-rider",
      initialPresence: (firstTick) => initialAccountRiderPresence(station, firstTick),
    };
  };

  return seededArrivalProcess({
    minGap: ACCOUNT_ARRIVAL_MIN_TICKS,
    maxGap: ACCOUNT_ARRIVAL_MAX_TICKS,
    rng,
    target: config.target,
    admit: makeAdmission,
  });
}
