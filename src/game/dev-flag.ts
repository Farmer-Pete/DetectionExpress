/**
 * The compile-time dev-kit switch and the co-located loader for the dev-only client.
 *
 * `process.env.PUBLIC_DEV_KIT` is the switch. Vite inlines it at build time through
 * `define` (`"true"` for `--mode devkit`, `"false"` for the dev server and
 * `--mode static`). A property read is safe when unset (it is `undefined`, not a
 * throw), so an unconfigured build defaults to off. The Vitest setup file sets
 * `process.env.PUBLIC_DEV_KIT = "true"` so the test run exercises the dev branch.
 *
 * `loadDevHostClient` co-locates the `if (DEV_KIT)` gate with the const so the
 * bundler folds it here and eliminates both the dynamic import and the whole
 * `dev-host-client` module from the static build. The inlined const folds to a
 * literal at its use site, so keeping the gate beside the const is what makes the
 * strip exact.
 */
import type { DevKitPanelModule } from "../ui/DevKitPanel";
import type { DevHostClient, DevHostClientDeps } from "./dev-host-client";

export const DEV_KIT: boolean = process.env.PUBLIC_DEV_KIT === "true";

/** The one export the App reads off the lazily loaded dev-host client module. */
export interface DevHostClientModule {
  createDevHostClient: (deps: DevHostClientDeps) => DevHostClient;
}

/** The dev-host client module when the dev kit is on, or null when it is off. */
export function loadDevHostClient(): Promise<DevHostClientModule> | null {
  if (DEV_KIT) {
    return import("./dev-host-client");
  }
  return null;
}

/**
 * The dev-kit panel module when the dev kit is on, or null when it is off. The gate
 * is co-located with the `DEV_KIT` const, exactly as `loadDevHostClient` above, so the
 * bundler folds it and `DevKitPanel` leaves the static bundle. This is the only edge from
 * `game/` to `ui/`; it is a dynamic import that the static build strips entirely, and
 * exists only in the dev build.
 */
export function loadDevKitPanel(): Promise<DevKitPanelModule> | null {
  if (DEV_KIT) {
    return import("../ui/DevKitPanel");
  }
  return null;
}
