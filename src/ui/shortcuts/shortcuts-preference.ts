/**
 * A guarded wrapper over `localStorage` for the persisted keyboard-shortcuts on/off
 * preference (WCAG 2.1.4, GH137-PLAN.md code review fix 4: the "turn off" mechanism
 * for single-character shortcuts). Mirrors `onboarding-storage.ts`'s own
 * guarded-read/guarded-write shape: a missing, blocked, or throwing `localStorage`
 * never breaks the app.
 *
 * Defaults ON (shortcuts enabled): only an explicit, persisted "off" turns them off,
 * so a missing key, a blocked store, or a fresh install all read as enabled — a
 * blocked store must never silently disable every mnemonic.
 */

const SHORTCUTS_ENABLED_KEY = "detection-express:shortcuts-enabled";
const DISABLED_VALUE = "false";

/** Read `localStorage` defensively. Some environments throw on the access itself. */
function readStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** True unless the preference was explicitly turned off and persisted. Any failure
 *  (missing/blocked storage) reads as true — the default. */
export function readShortcutsEnabled(): boolean {
  const storage = readStorage();
  if (storage === null) {
    return true;
  }
  try {
    return storage.getItem(SHORTCUTS_ENABLED_KEY) !== DISABLED_VALUE;
  } catch {
    return true;
  }
}

/** Persist the on/off preference. Turning it back on removes the stored key rather
 *  than writing an explicit "true" — the absence of the key already reads as enabled
 *  above, so there is only one on-disk representation of "off" to keep in sync. A
 *  missing or throwing store is swallowed, never raised, mirroring `markTourSeen`: a
 *  write failure must never block the toggle from taking effect this session. */
export function writeShortcutsEnabled(enabled: boolean): void {
  const storage = readStorage();
  if (storage === null) {
    return;
  }
  try {
    if (enabled) {
      storage.removeItem(SHORTCUTS_ENABLED_KEY);
    } else {
      storage.setItem(SHORTCUTS_ENABLED_KEY, DISABLED_VALUE);
    }
  } catch {
    // A write failure never blocks the toggle from taking effect this session.
  }
}
