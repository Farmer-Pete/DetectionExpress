/**
 * Pure resolution and framing helpers shared by the dev-only `algorithms-hmr` Vite
 * plugin (Node side, it stats the filesystem) and the dev client (browser side). No
 * `fs`, no DOM: plain string logic, so both sides import it and the same rules are
 * unit-tested off the browser.
 *
 * One engine, not one algorithm per slug. The player's local override is a single
 * fixed file, `src/algorithms/engine.ts`. When it exists on disk the run loads it;
 * otherwise the run falls back to the committed default engine at
 * `src/sim/default-engine.ts` (which is itself the composed single engine). The
 * handshake carries no slug: `algo:hello` asks for the one engine, and the plugin
 * replies `algo:changed { path, version }`.
 *
 * The override path is a compile-time constant, so there is no slug-to-path step and no
 * traversal surface at all: the resolver can only ever name `src/algorithms/engine.ts`
 * or the default.
 */

/** The player-override directory, as a root-relative URL prefix. The dev plugin derives
 * its filesystem subdirectory from this, so the URL path and the watched path cannot drift. */
export const ALGORITHMS_DIR = "/src/algorithms";

/** The one fixed player-override file. No slug: one engine detects every hunt. */
export const ENGINE_OVERRIDE_PATH = `${ALGORITHMS_DIR}/engine.ts`;

/** The committed fallback engine, loaded when the override file is absent. */
export const DEFAULT_ENGINE_PATH = "/src/sim/default-engine.ts";

/**
 * Resolve the active engine file: the override when it exists on disk, else the default
 * engine. `overrideExists` is supplied by the caller (the plugin's `fs.existsSync`, or a
 * fake in tests), so this stays pure and testable off the filesystem.
 */
export function resolveActiveFile(overrideExists: boolean): string {
  return overrideExists ? ENGINE_OVERRIDE_PATH : DEFAULT_ENGINE_PATH;
}

/** The slugless `algo:changed` frame the plugin pings and the client parses. */
export interface ChangedFrame {
  path: string;
  version: number;
}

/** Build the `algo:changed` frame for a resolved active file. */
export function buildChangedFrame(path: string, version: number): ChangedFrame {
  return { path, version };
}

/**
 * The cache-busting module URL the client imports and the profiler measures. `version`
 * is the plugin's monotonic counter, so an unchanged file reuses the URL (and the cached
 * rate) and a save bumps it to a fresh URL.
 */
export function localAlgorithmUrl(path: string, version: number): string {
  return `${path}?v=${version}`;
}

/**
 * The plugin's single monotonic version counter — the only source of versioning.
 * `current` answers a bootstrap `algo:hello` with the latest value; `bump` advances it
 * on each filesystem change under `src/algorithms/`.
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
