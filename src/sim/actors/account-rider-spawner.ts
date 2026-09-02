/**
 * The account-rider population spawner: a deterministic, seeded source of transient
 * account riders. The live run is perpetual, so a small cast is kept without unbounded
 * growth. On each tick it admits a fresh account rider whenever the live count is below
 * the target and an arrival is due, minting a new id per birth, drawing an account from
 * the given benign namespace, and picking a station and kiosk terminal to sign in at.
 *
 * All randomness comes from one seeded stream derived from the run seed, so the whole
 * admission sequence replays for a seed on one machine. No wall clock, no React
 * (ARCHITECTURE rule 8, ADR-0007). It mirrors the rider and staff spawners: a seeded
 * arrival process capped at a target, not the prototype's timer.
 *
 * Capped benign fumbles (GH126-PLAN.md M2a item 4): a visit fumbles its PIN at most
 * twice, then signs in, with the same fixed weights `pin-brute-force/cast.ts` uses
 * for its own benign traffic. Safe now that every benign account is drawn from
 * `config.benignAccounts`, a range disjoint from any chaos wave's attack namespace
 * (`account-namespace.ts`): a benign fumble burst can never land on an active
 * attack's victim account, and a cap of 2 sits well below any hunt's threshold.
 */
import { randomLcg } from "d3-random";
import {
  ACCOUNT_ARRIVAL_MAX_TICKS,
  ACCOUNT_ARRIVAL_MIN_TICKS,
  ACCOUNT_DWELL_TICKS,
} from "../../game/tuning";
import { KIOSK_TERMINALS } from "../endpoints/kiosk/internal";
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
  /**
   * The benign account range every visit draws from (`account-namespace.ts`'s
   * `BENIGN_ACCOUNT_NAMESPACE` in production; a test may pass its own fixture
   * pool). Disjoint from any chaos wave's attack namespace, by construction.
   */
  benignAccounts: readonly string[];
}

/** The per-visit fumble weights: P(0) = 0.90, P(1) = 0.07, P(2) = 0.03. Mirrors
 *  `pin-brute-force/cast.ts`'s own fumble weights; fixed, not tuned. */
const FUMBLE_P0 = 0.9;
const FUMBLE_P1 = 0.07;

/** Draw one visit's fumble count from the fixed weights, capped at 2 by construction. */
function drawFumbleFails(rng: () => number): 0 | 1 | 2 {
  const u = rng();
  if (u < FUMBLE_P0) {
    return 0;
  }
  if (u < FUMBLE_P0 + FUMBLE_P1) {
    return 1;
  }
  return 2;
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
  const accounts = config.benignAccounts;
  const stations = config.world.stations;

  let births = 0;

  const pick = <T>(items: readonly T[]): T | undefined => items[Math.floor(rng() * items.length)];

  const makeAdmission = (atTick: number): Admission<WorldReading, WorldEnv> => {
    const id = `A${String(births++).padStart(6, "0")}`;
    const account = pick(accounts) ?? "rider.x";
    const station = pick(stations)?.id ?? stations[0]?.id ?? "cen";
    const terminal = pick(KIOSK_TERMINALS) ?? "K1";
    const fumbleFails = drawFumbleFails(rng);
    const riderConfig: AccountRiderConfig = {
      id,
      account,
      station,
      terminal,
      startTick: atTick,
      dwellTicks: ACCOUNT_DWELL_TICKS,
      fumbleFails,
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
