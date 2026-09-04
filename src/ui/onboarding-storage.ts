/**
 * A guarded wrapper over `localStorage` for the persisted bit of onboarding state:
 * whether the player has seen the guided tour (GH132-PLAN.md M2). Every access is
 * guarded, so a missing, blocked, or throwing `localStorage` never breaks the app. A
 * failed read is treated as "not seen", and a failed write never blocks a dismissal.
 */

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
