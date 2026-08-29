/**
 * The dev-only gate and loader for the local-IDE algorithms client (86-PLAN.md M2b).
 * It mirrors `dev-flag.ts`: the `if (import.meta.env.DEV)` guard is co-located with the
 * dynamic import, so Vite folds `import.meta.env.DEV` to `false` in the production build
 * and eliminates both this import and the whole `algorithms-dev-client` module. The
 * production bundle carries none of it.
 *
 * `import.meta.env.DEV` replaces the old `PUBLIC_DEV_KIT` switch for this path; the M3
 * host retirement migrates the rest. No React import: this lives in `game/`.
 */
import type { AlgorithmsDevClientModule, HotChannelLike } from "./algorithms-dev-client";

/**
 * The Vite HMR channel adapted to the client's `HotChannelLike`, or null when there is
 * no dev server (a production build, or a non-Vite runtime like the test environment,
 * where `import.meta.hot` is undefined). The channel is only meaningful under the dev
 * server, so the client's minimal UI control gates on a non-null return.
 */
export function devHotChannel(): HotChannelLike | null {
  const hot = import.meta.hot;
  if (import.meta.env.DEV && hot !== undefined) {
    return {
      on: (event, handler) => hot.on(event, handler),
      off: (event, handler) => hot.off(event, handler),
      send: (event, data) => hot.send(event, data),
    };
  }
  return null;
}

/**
 * The algorithms-dev-client module when running under the dev server, or null in the
 * production build. The gate is co-located with the const `import`, exactly as
 * `dev-flag.ts`, so the bundler strips the client from the static build.
 */
export function loadAlgorithmsDevClient(): Promise<AlgorithmsDevClientModule> | null {
  if (import.meta.env.DEV) {
    return import("./algorithms-dev-client");
  }
  return null;
}
