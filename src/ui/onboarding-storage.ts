/**
 * A guarded wrapper over `localStorage` for the one persisted bit of onboarding
 * state: whether the player has seen the intro. Every access is guarded, so a
 * missing, blocked, or throwing `localStorage` never breaks the app. A failed
 * read is treated as "not seen", and a failed write never blocks a dismissal.
 */

const STORAGE_KEY = "detection-express:intro-seen";
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
