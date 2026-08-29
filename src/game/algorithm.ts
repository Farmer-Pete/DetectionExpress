/**
 * The Algorithm module loader. It wraps the player's source as a Blob module and
 * imports it, so a normal ES module (including absolute-URL library imports like
 * `https://esm.sh/lodash`) just works. Bare and relative specifiers are
 * unsupported: the browser has no import map for a Blob module.
 *
 * The loader is split in two so the validation logic is testable off the browser:
 *
 * - `adaptModule` is the pure part — it validates the loaded module and defaults a
 *   missing `normalize` to identity. It takes a plain object, so tests drive it with
 *   no blob import.
 * - `loadAlgorithm` is the thin browser shell — it imports the source through an
 *   injectable `importSource`, then hands the module to `adaptModule`. The default
 *   `importSource` does the blob import, which is browser only (Node's ESM loader
 *   rejects `blob:` URLs). Tests inject a fake `importSource` instead.
 *
 * Browser only, and potentially effectful: the player's own browser runs whatever
 * they import. The engine injects deterministic Rules for its own tests.
 */

/**
 * The loaded Rule the engine runs. Both callables return an untyped value: the
 * Detect task parses the return at its boundary. `normalize` defaults to identity
 * when the module omits it.
 */
export interface LoadedAlgorithm {
  normalize: (raw: unknown) => unknown;
  detect: (event: unknown) => unknown;
}

/** The exports we read off the player's module. Both may be missing or non-functions. */
export interface AlgorithmModule {
  detect?: unknown;
  normalize?: unknown;
}

/** Imports the player's source and resolves to its module namespace. */
export type ImportSource = (source: string) => Promise<AlgorithmModule>;

/** A one-argument callable. `instanceof Function` proves an export is callable. */
function asCallable(value: unknown): ((arg: unknown) => unknown) | null {
  if (value instanceof Function) {
    return (arg: unknown) => value(arg);
  }
  return null;
}

/**
 * Validate a loaded module and adapt it into the Rule the engine runs. Pure: no
 * blob, no import, no DOM. Throws when `detect` is missing or `normalize` is present
 * but not a function.
 */
export function adaptModule(loaded: AlgorithmModule): LoadedAlgorithm {
  const detect = asCallable(loaded.detect);
  if (!detect) {
    throw new Error("The Algorithm must export a `detect` function.");
  }
  let normalize: (raw: unknown) => unknown;
  if (loaded.normalize === undefined) {
    normalize = (data: unknown) => data; // omitted: default to identity
  } else {
    const callable = asCallable(loaded.normalize);
    if (!callable) {
      throw new Error("The Algorithm's `normalize` export, if present, must be a function.");
    }
    normalize = callable;
  }
  return { normalize, detect };
}

/**
 * Import the player's source as a Blob module. Browser only: Node's ESM loader
 * rejects `blob:` imports (`ERR_UNSUPPORTED_ESM_URL_SCHEME`). Covered by the app in
 * a real browser and the manual worker smoke, not by a Node unit test.
 */
const defaultImportSource: ImportSource = async (source) => {
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  try {
    return await import(url);
  } finally {
    URL.revokeObjectURL(url); // the module is resolved; the temporary URL is done
  }
};

/** Load and adapt the player's Algorithm. The blob import is injectable for tests. */
export async function loadAlgorithm(
  source: string,
  importSource: ImportSource = defaultImportSource,
): Promise<LoadedAlgorithm> {
  return adaptModule(await importSource(source));
}
