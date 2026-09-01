/**
 * The shared kiosk cast: the seeded identity pools and the actor assembly, used by
 * the pin-brute-force scenario and the calibration corpus. Both callers
 * keep their own timing policies; this module only mints identities, budgets benign
 * fumbles, and constructs the two actor kinds. No strategy pattern: a strategy
 * interface waits for a third caller (GH102 decision 7). Pure and seeded, no wall
 * clock, no React.
 *
 * Fumble budget (GH102 decision 2): a benign visit fumbles its PIN with fixed,
 * low probability, and the budgeter clamps each account to at most two fails per
 * fixed 150-tick (`SCAN_WINDOW_TICKS`) bucket. A rolling detection window overlaps
 * at most two such buckets, so a non-victim sees at most four benign fails in any
 * window — below the threshold of five. Victims fumble zero, so their only fails
 * are the attacker's. The clamp makes benign and attack traffic separable by
 * construction; the scenario's assertions are the double check.
 */
import { randomLcg } from "d3-random";
import {
  type AccountRiderConfig,
  createAccountRider,
  initialAccountRiderPresence,
} from "../../actors/account-rider";
import type { ActorDescriptor } from "../../actors/actor";
import { KIOSK_TERMINALS } from "../../endpoints/kiosk/internal";
import { buildAccounts } from "../../entities/account";
import type { World } from "../../world/world";
import type { WorldEnv, WorldReading } from "../../world-reading";
import {
  createPinAttacker,
  initialPinAttackerPresence,
  type PinAttackerConfig,
} from "./pin-attacker";
import { SCAN_WINDOW_TICKS } from "./tuning";

/**
 * The per-visit fumble probabilities (GH102 decision 2). P(0) = 0.90, P(1) = 0.07,
 * P(2) = 0.03, so a visit draws about 0.13 fails before the per-bucket clamp. Fixed
 * constants, not tuned: the separability proof rests on the clamp, not the mean.
 */
const FUMBLE_P0 = 0.9;
const FUMBLE_P1 = 0.07;

/** The most benign fails one account may carry inside a single 150-tick bucket. */
const MAX_FUMBLES_PER_BUCKET = 2;

/** The seeded identity pools a kiosk cast draws its patrons and attackers from. */
export interface IdentityPools {
  /** Distinct account logins, e.g. `"river.k"`, in fixed seeded order. */
  accounts: readonly string[];
  /** The world's station ids, in world order. */
  stations: readonly string[];
  /** The kiosk terminal ids a visit may use. */
  terminals: readonly string[];
}

/**
 * Draw one item from `items` with the seeded `rng`, one rng call per draw. Shared
 * by the scenario and the calibration corpus, both of which draw accounts,
 * stations, and terminals from these same identity pools. Throws if `items` is
 * empty, since an empty pool means the caller built its identities wrong.
 */
export function pickSeeded<T>(items: readonly T[], rng: () => number): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) {
    throw new Error("pickSeeded: drew from an empty pool.");
  }
  return item;
}

/**
 * Build the identity pools from the seeded rng: `accountCount` distinct accounts via
 * `buildAccounts` (killing the faker copies), the world's stations, and the kiosk
 * terminal pool. Deterministic and order-fixed for a seed.
 */
export function buildIdentityPools(
  rng: () => number,
  world: World,
  accountCount: number,
): IdentityPools {
  const accounts = buildAccounts(accountCount, rng).map((account) => account.name);
  const stations = world.stations.map((station) => station.id);
  return { accounts, stations, terminals: KIOSK_TERMINALS };
}

/**
 * A fixed seed for the shared partition namespace, independent of any run's own
 * seed. `buildPartitionedIdentityPools` mints its account slices from this one
 * constant source, never from a run's `rng`, so two runs generated from
 * unrelated seeds still draw guaranteed-disjoint accounts as long as they use
 * different partitions (GH42-PLAN.md "Composable streams: the merge seam"). A
 * run's own `rng` still decides which of its partition's accounts become
 * victims or patrons; only the namespace each partition draws from is fixed.
 */
const PARTITION_NAMESPACE_SEED = 0x9a1e5;

/**
 * How many disjoint partitions the shared namespace reserves. Each partition owns
 * one equal, fixed-size block, so partition K always maps to the same block of
 * accounts regardless of how many a run actually draws.
 */
const MAX_PARTITIONS = 8;

/**
 * The fixed block size each partition owns in the shared namespace. A partition's
 * accounts always start at `partition * ACCOUNTS_PER_PARTITION`, so its range
 * depends only on this block size, never on the caller's `accountCount`. That is
 * what keeps partitions disjoint by construction even when their runs draw
 * different counts.
 */
const ACCOUNTS_PER_PARTITION = 64;

/**
 * The one shared partition namespace, built ONCE at module load:
 * `MAX_PARTITIONS * ACCOUNTS_PER_PARTITION` distinct account names minted from the
 * fixed `PARTITION_NAMESPACE_SEED`, independent of any run's own seed.
 * `buildAccounts` enforces its own name-supply ceiling at construction, so an
 * over-large product fails here at module load rather than silently returning a
 * short pool. `buildPartitionedIdentityPools` only slices this const; it never
 * rebuilds it per call.
 */
const PARTITION_NAMESPACE = buildAccounts(
  MAX_PARTITIONS * ACCOUNTS_PER_PARTITION,
  randomLcg(PARTITION_NAMESPACE_SEED),
).map((account) => account.name);

/**
 * The identity pools for one partition of a composed (merged) run. `accounts` is a
 * fixed equal block of the shared `PARTITION_NAMESPACE`, chosen by `partition`, not
 * from any run's own seed or count, so partition K always maps to the same accounts
 * and two runs on different partitions never share one. Stations and terminals are
 * already world-fixed, so they need no partitioning.
 *
 * Throws on a `partition` outside `[0, MAX_PARTITIONS)`: a caller asking for an
 * unreserved partition would otherwise slice past the namespace and get an
 * under-full pool, corrupting the disjointness guarantee this function exists to
 * provide. Throws on an `accountCount` outside `[0, ACCOUNTS_PER_PARTITION]`: a
 * wider slice would spill into the next partition's block, and a NaN, negative, or
 * fractional count is a caller bug.
 */
export function buildPartitionedIdentityPools(
  world: World,
  accountCount: number,
  partition: number,
): IdentityPools {
  if (!Number.isInteger(partition) || partition < 0 || partition >= MAX_PARTITIONS) {
    throw new Error(
      `buildPartitionedIdentityPools: partition must be an integer in [0, ${MAX_PARTITIONS}), got ${partition}.`,
    );
  }
  if (
    !Number.isInteger(accountCount) ||
    accountCount < 0 ||
    accountCount > ACCOUNTS_PER_PARTITION
  ) {
    throw new Error(
      `buildPartitionedIdentityPools: accountCount must be an integer in [0, ${ACCOUNTS_PER_PARTITION}], got ${accountCount}.`,
    );
  }
  const start = partition * ACCOUNTS_PER_PARTITION;
  const accounts = PARTITION_NAMESPACE.slice(start, start + accountCount);
  const stations = world.stations.map((station) => station.id);
  return { accounts, stations, terminals: KIOSK_TERMINALS };
}

/** One benign visit's account and sign-in tick, the budgeter's input. */
export interface BenignVisit {
  account: string;
  /** The sign-in tick, which fixes the 150-tick bucket. */
  tick: number;
}

/** Draw a raw fumble count from the fixed weights: 0 (0.90), 1 (0.07), or 2 (0.03). */
function drawRawFumble(rng: () => number): 0 | 1 | 2 {
  const u = rng();
  if (u < FUMBLE_P0) {
    return 0;
  }
  if (u < FUMBLE_P0 + FUMBLE_P1) {
    return 1;
  }
  return 2;
}

/**
 * Clamp a raw fumble count to the bucket's remaining budget, keeping the `0 | 1 | 2`
 * literal type by branching rather than asserting. `allowed` is `2 - used` with
 * `used` in `{0, 1, 2}`, so it too is in `{0, 1, 2}`.
 */
function clampFumbles(raw: 0 | 1 | 2, allowed: number): 0 | 1 | 2 {
  if (allowed >= raw) {
    return raw;
  }
  if (allowed <= 0) {
    return 0;
  }
  return 1;
}

/**
 * Walk the visits in the given order and assign each a fumble count, clamped so no
 * account exceeds `MAX_FUMBLES_PER_BUCKET` fails per fixed 150-tick bucket. Victims
 * always get 0 (their only fails are the attacker's). A raw draw is taken for every
 * visit so the non-victim pattern is stable regardless of which slots are victims.
 * Returns one count per visit, aligned by index.
 */
export function budgetFumbles(
  visits: readonly BenignVisit[],
  victims: ReadonlySet<string>,
  rng: () => number,
): (0 | 1 | 2)[] {
  const usedByBucket = new Map<string, number>();
  return visits.map((visit) => {
    const raw = drawRawFumble(rng);
    if (victims.has(visit.account)) {
      return 0;
    }
    const bucket = Math.floor(visit.tick / SCAN_WINDOW_TICKS);
    const key = `${visit.account}:${bucket}`;
    const used = usedByBucket.get(key) ?? 0;
    const allowed = MAX_FUMBLES_PER_BUCKET - used;
    const count = clampFumbles(raw, allowed);
    usedByBucket.set(key, used + count);
    return count;
  });
}

/** One benign patron to assemble: an account rider signing in at a kiosk. */
export interface PatronSpec {
  id: string;
  account: string;
  station: string;
  terminal: string;
  startTick: number;
  dwellTicks: number;
  fumbleFails: 0 | 1 | 2;
}

/**
 * Describe one benign patron over the account-rider factory: an immutable
 * `AccountRiderConfig` plus a pure `build()` that constructs a fresh actor from it,
 * so the same descriptor can be instantiated more than once with no shared state
 * (GH117-PLAN.md "the immutable blueprint seam").
 */
export function assemblePatron(spec: PatronSpec): ActorDescriptor<WorldReading, WorldEnv> {
  const config: AccountRiderConfig = {
    id: spec.id,
    account: spec.account,
    station: spec.station,
    terminal: spec.terminal,
    startTick: spec.startTick,
    dwellTicks: spec.dwellTicks,
    fumbleFails: spec.fumbleFails,
  };
  return {
    provenance: "scored-scenario",
    kind: "account-rider",
    initialPresence: (firstTick) => initialAccountRiderPresence(config.station, firstTick),
    build: () => createAccountRider(config),
  };
}

/** One PIN attacker to assemble, carrying the attack id its fails belong to. */
export interface AttackerSpec {
  id: string;
  attackId: number;
  account: string;
  station: string;
  terminal: string;
  failTimestamps: number[];
}

/**
 * Describe one PIN attacker and its ground-truth label. The label is the
 * `(actorId, attackId)` entry the composer's `attackIdOf` reads back: every fail
 * reading from this actor belongs to `attackId`. The descriptor mirrors
 * `assemblePatron`: an immutable `PinAttackerConfig` plus a pure `build()`.
 */
export function assembleAttacker(spec: AttackerSpec): {
  descriptor: ActorDescriptor<WorldReading, WorldEnv>;
  label: [string, number];
} {
  const config: PinAttackerConfig = {
    id: spec.id,
    account: spec.account,
    station: spec.station,
    terminal: spec.terminal,
    failTimestamps: spec.failTimestamps,
  };
  const descriptor: ActorDescriptor<WorldReading, WorldEnv> = {
    provenance: "scored-scenario",
    kind: "pin-attacker",
    initialPresence: (firstTick) => initialPinAttackerPresence(config.station, firstTick),
    build: () => createPinAttacker(config),
  };
  return { descriptor, label: [spec.id, spec.attackId] };
}
