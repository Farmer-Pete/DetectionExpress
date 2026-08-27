/**
 * The Algorithm module loader. It wraps the player's source as a Blob module and
 * imports it, so a normal ES module (including absolute-URL library imports like
 * `https://esm.sh/lodash`) just works. Bare and relative specifiers are
 * unsupported: the browser has no import map for a Blob module.
 *
 * Browser only, and potentially effectful: the player's own browser runs whatever
 * they import. Tests never call this; they inject deterministic Rules instead.
 */

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
interface AlgorithmModule {
  match?: unknown;
  normalize?: unknown;
}

/** A one-argument callable. `instanceof Function` proves an export is callable. */
function asCallable(value: unknown): ((arg: unknown) => unknown) | null {
  if (value instanceof Function) {
    return (arg: unknown) => value(arg);
  }
  return null;
}

export async function loadAlgorithm(source: string): Promise<LoadedAlgorithm> {
  const blob = new Blob([source], { type: "text/javascript" });
  const url = URL.createObjectURL(blob);
  let loaded: AlgorithmModule;
  try {
    loaded = await import(url);
  } finally {
    URL.revokeObjectURL(url); // the module is resolved; the temporary URL is done
  }

  const match = asCallable(loaded.match);
  if (!match) {
    throw new Error("The Algorithm must export a `match` function.");
  }
  const normalize = asCallable(loaded.normalize) ?? ((data: unknown) => data);
  return { normalize, match };
}
