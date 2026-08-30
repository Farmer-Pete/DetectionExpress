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
import { type Account, buildAccounts } from "../entities/account";
import type { World } from "../world/world";
import type { WorldEnv, WorldReading } from "../world-reading";
import {
  type AccountRiderConfig,
  createAccountRider,
  initialAccountRiderPresence,
} from "./account-rider";
import { type Admission, actorSeedHash } from "./actor";

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

/** The kiosk terminals an account rider may sign in at; drawn per birth. */
const TERMINALS: readonly string[] = ["K1", "K2"];

export function createAccountRiderSpawner(config: AccountRiderSpawnerConfig): AccountRiderSpawner {
  // A distinct seeded stream, keyed off the run seed but separate from every actor's,
  // so the spawn cadence never shares a stream with an account rider's own draws.
  const rng = randomLcg(actorSeedHash(config.seed, "account-rider-spawner"));
  const accounts = buildAccounts(ACCOUNT_POOL, rng);
  const stations = config.world.stations;
  const gapSpan = ACCOUNT_ARRIVAL_MAX_TICKS - ACCOUNT_ARRIVAL_MIN_TICKS + 1;

  let births = 0;
  // The next tick an arrival is considered. Starts at 0 so the cast fills from the
  // first tick, then advances by a seeded gap after each arrival.
  let nextArrival = 0;

  const drawGap = (): number => ACCOUNT_ARRIVAL_MIN_TICKS + Math.floor(rng() * gapSpan);

  const pick = <T>(items: readonly T[]): T | undefined => items[Math.floor(rng() * items.length)];

  const makeAdmission = (atTick: number): Admission<WorldReading, WorldEnv> => {
    const id = `A${String(births++).padStart(6, "0")}`;
    const account: Account = pick(accounts) ?? { name: "rider.x" };
    const station = pick(stations)?.id ?? stations[0]?.id ?? "cen";
    const terminal = pick(TERMINALS) ?? "K1";
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

  return {
    tick: (nowTick, liveAccountRiders) => {
      const admissions: Admission<WorldReading, WorldEnv>[] = [];
      while (nextArrival <= nowTick) {
        if (liveAccountRiders + admissions.length < config.target) {
          admissions.push(makeAdmission(nowTick));
        }
        // Advance past this arrival whether or not it was filled, so a full cast drops
        // the arrival rather than backing up unboundedly.
        nextArrival += drawGap();
      }
      return admissions;
    },
  };
}
