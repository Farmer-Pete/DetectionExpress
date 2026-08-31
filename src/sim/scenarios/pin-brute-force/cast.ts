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
import { type AccountRiderConfig, createAccountRider } from "../../actors/account-rider";
import type { Actor } from "../../actors/actor";
import { KIOSK_TERMINALS } from "../../endpoints/kiosk/internal";
import { buildAccounts } from "../../entities/account";
import type { World } from "../../world/world";
import type { WorldEnv, WorldReading } from "../../world-reading";
import { createPinAttacker, type PinAttackerConfig } from "./pin-attacker";
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
 * How many disjoint partitions the fixed namespace reserves. `buildAccounts`
 * caps its own ceiling at `STEMS.length * 26` (520 today), so this must stay
 * comfortably under `520 / accountCount` for the accountCount this scenario
 * actually uses (40): 8 partitions of 40 is 320, well inside that ceiling.
 * Bump it if a future merge ever needs more concurrent runs.
 */
const MAX_PARTITIONS = 8;

/**
 * The identity pools for one partition of a composed (merged) run. `accounts`
 * comes from the fixed `PARTITION_NAMESPACE_SEED` namespace, sliced by
 * `partition`, not from any run's own seed, so two runs given different
 * partitions never share an account no matter what seed generated each run.
 * Stations and terminals are already world-fixed, so they need no partitioning.
 *
 * Throws on a `partition` outside `[0, MAX_PARTITIONS)`: a caller asking for an
 * unreserved partition would otherwise silently slice past the namespace and
 * get an under-full (or empty) pool, corrupting the disjointness guarantee this
 * function exists to provide.
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
  const namespace = buildAccounts(
    accountCount * MAX_PARTITIONS,
    randomLcg(PARTITION_NAMESPACE_SEED),
  ).map((account) => account.name);
  const start = partition * accountCount;
  const accounts = namespace.slice(start, start + accountCount);
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

/** Construct one benign patron actor over the account-rider factory. */
export function assemblePatron(spec: PatronSpec): Actor<WorldReading, WorldEnv> {
  const config: AccountRiderConfig = {
    id: spec.id,
    account: spec.account,
    station: spec.station,
    terminal: spec.terminal,
    startTick: spec.startTick,
    dwellTicks: spec.dwellTicks,
    fumbleFails: spec.fumbleFails,
  };
  return createAccountRider(config);
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
 * Construct one PIN attacker actor and its ground-truth label. The label is the
 * `(actorId, attackId)` entry the composer's `attackIdOf` reads back: every fail
 * reading from this actor belongs to `attackId`.
 */
export function assembleAttacker(spec: AttackerSpec): {
  actor: Actor<WorldReading, WorldEnv>;
  label: [string, number];
} {
  const config: PinAttackerConfig = {
    id: spec.id,
    account: spec.account,
    station: spec.station,
    terminal: spec.terminal,
    failTimestamps: spec.failTimestamps,
  };
  return { actor: createPinAttacker(config), label: [spec.id, spec.attackId] };
}
