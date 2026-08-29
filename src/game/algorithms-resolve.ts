/**
 * Pure resolution and framing helpers shared by the dev-only `algorithms-hmr` Vite
 * plugin (Node side, it stats the filesystem) and the dev client (browser side, it
 * subscribes by slug). No `fs`, no DOM: plain string logic, so both sides import it
 * and the same rules are unit-tested off the browser.
 *
 * The active file for a slug is the player override `src/algorithms/<slug>.ts` when it
 * exists on disk, else the committed default engine at `src/game/default-engine.ts`
 * (86-PLAN.md "Loading path"). Paths are ROOT-RELATIVE URLs (`/src/...`) so Vite serves
 * them directly and the client can `import(path + "?v=" + version)`.
 *
 * The slug is validated against `^[a-z0-9-]{1,64}$` before anything touches the
 * filesystem, and the pattern admits no `/` or `.`, so a resolved override path can only
 * name a file directly under `src/algorithms/`. There is no arbitrary slug-to-path step,
 * so no traversal surface.
 */

/** The one legal slug shape. No `/`, no `.`, so it cannot escape `src/algorithms/`. */
const ALGORITHM_SLUG_PATTERN = /^[a-z0-9-]{1,64}$/;

/** The player-override directory, as a root-relative URL prefix. The dev plugin derives its
 * filesystem subdirectory from this, so the URL path and the watched path cannot drift. */
export const ALGORITHMS_DIR = "/src/algorithms";

/** The committed fallback engine, loaded when a slug has no override on disk. */
export const DEFAULT_ENGINE_PATH = "/src/game/default-engine.ts";

/** True when `slug` matches the one legal shape. An invalid slug never touches the fs. */
export function isValidAlgorithmSlug(slug: string): boolean {
  return ALGORITHM_SLUG_PATTERN.test(slug);
}

/** The root-relative URL of a slug's override file. Caller must validate the slug first. */
export function overridePath(slug: string): string {
  return `${ALGORITHMS_DIR}/${slug}.ts`;
}

/**
 * Resolve the active file for a slug, given an `exists` predicate the caller supplies
 * (the plugin's `fs.existsSync`, or a fake in tests). Returns null for an invalid slug
 * WITHOUT calling `exists`, so an invalid slug never triggers a filesystem read. A valid
 * slug resolves to its override when `exists(slug)` is true, else the default engine.
 */
export function resolveActiveFile(slug: string, exists: (slug: string) => boolean): string | null {
  if (!isValidAlgorithmSlug(slug)) {
    return null; // never calls exists: no fs touch for an invalid slug
  }
  return exists(slug) ? overridePath(slug) : DEFAULT_ENGINE_PATH;
}

/**
 * The boolean-input form of `resolveActiveFile`: resolve given whether the override
 * already exists (86-PLAN.md M2 test seam `selectActiveFile(slug, files)`). Returns null
 * for an invalid slug.
 */
export function selectActiveFile(slug: string, overrideExists: boolean): string | null {
  return resolveActiveFile(slug, () => overrideExists);
}

/** The `algo:changed` frame the plugin pings and the client parses. */
export interface ChangedFrame {
  slug: string;
  path: string;
  version: number;
}

/** Build the `algo:changed` frame for a resolved active file. */
export function buildChangedFrame(slug: string, path: string, version: number): ChangedFrame {
  return { slug, path, version };
}

/**
 * The cache-busting module URL the client imports and the profiler measures. `version`
 * is the plugin's monotonic counter, so an unchanged file reuses the URL (and the cached
 * rate) and a save bumps it to a fresh URL (86-PLAN.md "cache identity").
 */
export function localAlgorithmUrl(path: string, version: number): string {
  return `${path}?v=${version}`;
}

/**
 * The plugin's single monotonic version counter — "the only source of versioning"
 * (86-PLAN.md). `current` answers a bootstrap `algo:hello` with the latest value;
 * `bump` advances it on each filesystem change under `src/algorithms/`.
 */
export interface VersionCounter {
  current(): number;
  bump(): number;
}

/** Create a monotonic counter starting at 0. `bump` pre-increments and returns. */
export function createVersionCounter(): VersionCounter {
  let value = 0;
  return {
    current: () => value,
    bump: () => {
      value += 1;
      return value;
    },
  };
}
