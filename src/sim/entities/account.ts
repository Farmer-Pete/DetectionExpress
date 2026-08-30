/**
 * The account entity: a rider's account identity, nothing more. An account is one
 * login with one username; the balance and PIN are not here, because they are running
 * state a later ticket owns (ADR-0007). `buildAccounts` mints a seeded, distinct pool
 * at scenario assembly, mirroring `card.ts` and `badge.ts`: the account rider signs in
 * under one of these names at a station kiosk.
 */

/**
 * The username stems the seeded pool draws from. Each account name is a stem, a dot,
 * and a letter (the `sensors.json` style, e.g. `"river.k"`), so the pool reads like
 * real transit logins. The stems name places and roles from the metro world.
 */
const STEMS: readonly string[] = [
  "river",
  "market",
  "harbor",
  "summit",
  "bay",
  "park",
  "central",
  "junction",
  "worldsend",
  "signal",
  "depot",
  "eastyard",
  "transit",
  "metro",
  "gate",
  "kiosk",
  "fare",
  "line",
  "platform",
  "concourse",
];

export interface Account {
  /** The login username, e.g. `"river.k"`. */
  name: string;
}

/**
 * A deterministic pool of `count` distinct account names drawn from the seeded rng.
 * The same seed always mints the same pool: each name is distinct (so one account's
 * sign-ins are one login's, never two interleaved) and shaped `stem.letter`. Each
 * attempt draws a stem then a letter, so the draw order is fixed and the pool replays
 * for a seed.
 */
export function buildAccounts(count: number, rng: () => number): Account[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`buildAccounts: count must be a finite non-negative integer, got ${count}.`);
  }
  const names = new Set<string>();
  while (names.size < count) {
    const stem = STEMS[Math.floor(rng() * STEMS.length)] ?? STEMS[0] ?? "rider";
    const letter = String.fromCharCode(97 + Math.floor(rng() * 26));
    names.add(`${stem}.${letter}`);
  }
  return [...names].map((name) => ({ name }));
}
