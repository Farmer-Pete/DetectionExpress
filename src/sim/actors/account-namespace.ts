/**
 * The account-namespace partition (GH126-PLAN.md M2a item 4): a shared constant
 * that reserves two disjoint account ranges, fixed independently of any run's own
 * seed, mirroring `pin-brute-force/cast.ts`'s own `PARTITION_NAMESPACE`. The
 * account-rider spawner draws every benign victim from `BENIGN_ACCOUNT_NAMESPACE`;
 * a chaos wave draws its victim from `ATTACK_ACCOUNT_NAMESPACE`. The two ranges
 * never intersect, so a benign fumble burst can never land on an active attack's
 * victim account, by construction, with no live coordination needed between the
 * spawner and a wave.
 *
 * Lives in `sim/actors/` (not `pin-brute-force/`) because the spawner is shared
 * generation machinery every scenario can draw benign traffic from, while
 * `pin-brute-force/` imports it for the attack side (ARCHITECTURE's `actors/`
 * folder rule).
 */
import { randomLcg } from "d3-random";
import { buildAccounts } from "../entities/account";

/**
 * A fixed seed for this shared namespace, independent of any run's own seed and
 * distinct from `pin-brute-force/cast.ts`'s `PARTITION_NAMESPACE_SEED`, so the two
 * partitioning schemes never draw from the same underlying sequence.
 */
const ACCOUNT_NAMESPACE_SEED = 0xac7b1e;

/** How many accounts the benign range reserves. */
const BENIGN_NAMESPACE_SIZE = 64;

/** How many accounts the attack range reserves. */
const ATTACK_NAMESPACE_SIZE = 64;

/**
 * One shared pool, built ONCE at module load from the fixed
 * `ACCOUNT_NAMESPACE_SEED`: the benign range occupies its first
 * `BENIGN_NAMESPACE_SIZE` names, the attack range the rest. Slicing one seeded
 * pool, rather than building two independently seeded ones, is what makes the two
 * ranges disjoint by construction instead of by convention.
 */
const ACCOUNT_NAMESPACE = buildAccounts(
  BENIGN_NAMESPACE_SIZE + ATTACK_NAMESPACE_SIZE,
  randomLcg(ACCOUNT_NAMESPACE_SEED),
).map((account) => account.name);

/** Every benign victim the account-rider spawner may draw. Disjoint from the attack range. */
export const BENIGN_ACCOUNT_NAMESPACE: readonly string[] = ACCOUNT_NAMESPACE.slice(
  0,
  BENIGN_NAMESPACE_SIZE,
);

/** Every account a chaos wave may draw its victim from. Disjoint from the benign range. */
export const ATTACK_ACCOUNT_NAMESPACE: readonly string[] =
  ACCOUNT_NAMESPACE.slice(BENIGN_NAMESPACE_SIZE);
