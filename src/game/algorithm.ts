/**
 * The Algorithm module loader. It imports the player's Rule as a real ES module: a
 * runtime source string (the in-game editor), wrapped as a Blob module and imported.
 * A normal ES module (including absolute-URL library imports like
 * `https://esm.sh/lodash`) just works. Bare and relative specifiers are unsupported
 * for a Blob module: the browser has no import map for it.
 *
 * The loader is split in two so the validation logic is testable off the browser:
 *
 * - `adaptModule` is the pure part — it validates the loaded module and defaults a
 *   missing `normalize` to identity. It takes a plain object, so tests drive it with
 *   no blob import.
 * - `loadAlgorithm` is the thin browser shell — it imports a source string through an
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
  normalize: (raw: unknown, endpoint: string) => unknown;
  detect: (event: unknown) => unknown;
}

/** The exports we read off the player's module. Both may be missing or non-functions. */
export interface AlgorithmModule {
  detect?: unknown;
  normalize?: unknown;
}

/** Imports a source string and resolves to its namespace. */
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
  let normalize: (raw: unknown, endpoint: string) => unknown;
  if (loaded.normalize === undefined) {
    normalize = (data: unknown) => data; // omitted: default to identity
  } else if (loaded.normalize instanceof Function) {
    // Forward the endpoint too: one engine over many wire formats dispatches
    // `normalize(raw, endpoint)` on it. A single-format module simply ignores it.
    const fn = loaded.normalize;
    normalize = (raw: unknown, endpoint: string) => fn(raw, endpoint);
  } else {
    throw new Error("The Algorithm's `normalize` export, if present, must be a function.");
  }
  return { normalize, detect };
}

/**
 * Import a source string as a real ES module: wrap it as a Blob module and import
 * that. Browser only: Node's ESM loader rejects `blob:` imports
 * (`ERR_UNSUPPORTED_ESM_URL_SCHEME`). Covered by the app in a real browser and the
 * manual worker smoke, not by a Node unit test.
 */
const defaultImportSource: ImportSource = async (source) => {
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  try {
    // `@vite-ignore`: a blob: URL is not analyzable; silence Vite's static-import warning.
    return await import(/* @vite-ignore */ url);
  } finally {
    URL.revokeObjectURL(url); // the module is resolved; the temporary URL is done
  }
};

/** Load and adapt the player's Algorithm. The import is injectable for tests. */
export async function loadAlgorithm(
  source: string,
  importSource: ImportSource = defaultImportSource,
): Promise<LoadedAlgorithm> {
  return adaptModule(await importSource(source));
}
