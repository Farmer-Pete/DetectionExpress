/**
 * The Algorithm module loader. It imports the player's Rule as a real ES module
 * two ways behind one seam: a Vite-served module URL (local-IDE mode), imported
 * directly, or a runtime source string (the in-game editor), wrapped as a Blob
 * module first. Either way a normal ES module (including absolute-URL library
 * imports like `https://esm.sh/lodash`) just works. Bare and relative specifiers
 * are unsupported for a Blob module: the browser has no import map for it.
 *
 * The loader is split in two so the validation logic is testable off the browser:
 *
 * - `adaptModule` is the pure part — it validates the loaded module and defaults a
 *   missing `normalize` to identity. It takes a plain object, so tests drive it with
 *   no blob import.
 * - `loadAlgorithm` is the thin browser shell — it imports a `LoadTarget` through an
 *   injectable `importSource`, then hands the module to `adaptModule`. The default
 *   `importSource` imports the URL (url mode) or does the blob import (source mode),
 *   which is browser only (Node's ESM loader rejects `blob:` URLs). Tests inject a
 *   fake `importSource` instead.
 *
 * Browser only, and potentially effectful: the player's own browser runs whatever
 * they import. The engine injects deterministic Rules for its own tests.
 */

/**
 * The controller's one input, discriminated by mode (86-PLAN.md "One controller
 * input"). It carries everything the run, the profiler, and the calibration cache
 * need, for both modes:
 *
 * - `url` — local-IDE mode. `url = path + "?v=" + version`, where `version` is the
 *   dev plugin's monotonic counter. `path` and `version` are the cache identity; the
 *   `url` is what the loader and profiler import.
 * - `source` — the in-game editor. The runtime source string, blob-imported.
 */
export type AlgorithmSource =
  | { kind: "url"; path: string; version: number; url: string }
  | { kind: "source"; source: string };

/**
 * What the loader and the profiler actually import: a served module URL, or a
 * runtime source string. Derived from an `AlgorithmSource` by `toLoadTarget`, which
 * drops the cache-only `path`/`version`. This is also the profiler Worker request's
 * discriminated payload, so the minimal shape crosses the postMessage boundary.
 */
export type LoadTarget = { kind: "url"; url: string } | { kind: "source"; source: string };

/** Reduce an `AlgorithmSource` to the minimal `LoadTarget` the loader and profiler import. */
export function toLoadTarget(algorithmSource: AlgorithmSource): LoadTarget {
  return algorithmSource.kind === "url"
    ? { kind: "url", url: algorithmSource.url }
    : { kind: "source", source: algorithmSource.source };
}

/**
 * The loaded Rule the engine runs. Both callables return an untyped value: the
 * Match task parses the return at its boundary. `normalize` defaults to identity
 * when the module omits it.
 */
export interface LoadedAlgorithm {
  normalize: (raw: unknown) => unknown;
  match: (event: unknown) => unknown;
}

/** The exports we read off the player's module. Both may be missing or non-functions. */
export interface AlgorithmModule {
  match?: unknown;
  normalize?: unknown;
}

/** Imports a `LoadTarget` (a module URL or a source string) and resolves to its namespace. */
export type ImportSource = (target: LoadTarget) => Promise<AlgorithmModule>;

/** A one-argument callable. `instanceof Function` proves an export is callable. */
function asCallable(value: unknown): ((arg: unknown) => unknown) | null {
  if (value instanceof Function) {
    return (arg: unknown) => value(arg);
  }
  return null;
}

/**
 * Validate a loaded module and adapt it into the Rule the engine runs. Pure: no
 * blob, no import, no DOM. Throws when `match` is missing or `normalize` is present
 * but not a function.
 */
export function adaptModule(loaded: AlgorithmModule): LoadedAlgorithm {
  const match = asCallable(loaded.match);
  if (!match) {
    throw new Error("The Algorithm must export a `match` function.");
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
  return { normalize, match };
}

/**
 * Append a per-load nonce to a url-mode import URL, so each load is a distinct URL. The
 * browser evaluates a module once per URL, so re-importing the same `?v=` URL returns the
 * cached instance with its module-scope state intact. A re-entry (same version) or the
 * main-thread profiler would then run against dirty state. The `?v=` version stays the
 * rate-cache key; this nonce only forces a fresh module instance per load.
 */
export function freshModuleUrl(url: string, nonce: number): string {
  return `${url}${url.includes("?") ? "&" : "?"}r=${nonce}`;
}

/** Per-load counter behind `freshModuleUrl`. Each url import gets a unique URL. */
let importNonce = 0;

/**
 * Import a `LoadTarget` as a real ES module. In url mode the browser imports the
 * Vite-served module URL, freshened with a per-load nonce so each load is a new module
 * instance and never a cached one with stale state. In source mode it wraps the string as
 * a Blob module and imports that. Browser only: Node's ESM loader rejects `blob:` imports
 * (`ERR_UNSUPPORTED_ESM_URL_SCHEME`). Covered by the app in a real browser and the manual
 * worker smoke, not by a Node unit test.
 */
const defaultImportSource: ImportSource = async (target) => {
  if (target.kind === "url") {
    importNonce += 1;
    // `@vite-ignore`: keep this dynamic import out of Vite's static analysis. Otherwise
    // Vite tracks the module and full-reloads the page on every save, instead of letting
    // the algorithms-hmr plugin suppress the reload and drive a seamless re-import.
    return await import(/* @vite-ignore */ freshModuleUrl(target.url, importNonce));
  }
  const url = URL.createObjectURL(new Blob([target.source], { type: "text/javascript" }));
  try {
    // `@vite-ignore`: a blob: URL is not analyzable; silence the same Vite warning.
    return await import(/* @vite-ignore */ url);
  } finally {
    URL.revokeObjectURL(url); // the module is resolved; the temporary URL is done
  }
};

/** Load and adapt the player's Algorithm. The import is injectable for tests. */
export async function loadAlgorithm(
  target: LoadTarget,
  importSource: ImportSource = defaultImportSource,
): Promise<LoadedAlgorithm> {
  return adaptModule(await importSource(target));
}
