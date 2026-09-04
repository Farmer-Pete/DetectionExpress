/**
 * A guarded wrapper over `localStorage` for the persisted bits of onboarding state:
 * whether the player has seen the intro, and (GH132-PLAN.md M2) whether they have seen
 * the guided tour. Every access is guarded, so a missing, blocked, or throwing
 * `localStorage` never breaks the app. A failed read is treated as "not seen", and a
 * failed write never blocks a dismissal.
 *
 * The tour's flag is a fresh key (`detection-express:tour-seen`), not a reuse of the
 * intro's: a player who already dismissed the old intro still sees the new tour once
 * (docs/adr/0012-guided-tour.md).
 */

const STORAGE_KEY = "detection-express:intro-seen";
const TOUR_STORAGE_KEY = "detection-express:tour-seen";
const SEEN_VALUE = "true";

/** Read `localStorage` defensively. Some environments throw on the access itself. */
function readStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** True only when the seen flag is present and set. Any failure reads as false. */
export function hasSeenIntro(): boolean {
  const storage = readStorage();
  if (storage === null) {
    return false;
  }
  try {
    return storage.getItem(STORAGE_KEY) === SEEN_VALUE;
  } catch {
    return false;
  }
}

/** Persist the seen flag. A missing or throwing store is swallowed, never raised. */
export function markIntroSeen(): void {
  const storage = readStorage();
  if (storage === null) {
    return;
  }
  try {
    storage.setItem(STORAGE_KEY, SEEN_VALUE);
  } catch {
    // A write failure never blocks a dismissal. The overlay still closes.
  }
}

/** True only when the tour's seen flag is present and set. Any failure reads as false. */
export function hasSeenTour(): boolean {
  const storage = readStorage();
  if (storage === null) {
    return false;
  }
  try {
    return storage.getItem(TOUR_STORAGE_KEY) === SEEN_VALUE;
  } catch {
    return false;
  }
}

/** Persist the tour's seen flag. A missing or throwing store is swallowed, never
 *  raised — `use-tour.ts`'s `onDestroyed` handler must never throw. */
export function markTourSeen(): void {
  const storage = readStorage();
  if (storage === null) {
    return;
  }
  try {
    storage.setItem(TOUR_STORAGE_KEY, SEEN_VALUE);
  } catch {
    // A write failure never blocks a dismissal.
  }
}
