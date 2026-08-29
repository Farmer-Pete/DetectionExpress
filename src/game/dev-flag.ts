/**
 * The compile-time dev-kit switch and the co-located loader for the dev-only client.
 *
 * `process.env.PUBLIC_DEV_KIT` is the switch. It is inlined at bundle time: the
 * `bun build` path uses `--define 'process.env.PUBLIC_DEV_KIT="true|false"'`, and the
 * `bun ./index.html` dev server inlines it from the real env via bunfig
 * `[serve.static] env = "PUBLIC_*"`. A property read is safe when unset (it is
 * `undefined`, not a throw), so an unconfigured build defaults to off. The test
 * preload sets `process.env.PUBLIC_DEV_KIT = "true"` so `bun test` exercises the dev
 * branch. Bun's HTML dev server ignores a CLI `--define`, which is why the flag is an
 * env read, not a bare define.
 *
 * `loadDevHostClient` co-locates the `if (DEV_KIT)` gate with the const so Bun folds
 * it here and eliminates both the dynamic import and the whole `dev-host-client`
 * module from the static build. Bun does not inline an exported const across module
 * boundaries, so a gate in another module would not strip; keeping the gate beside
 * the const is what makes the strip exact.
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
 * is co-located with the `DEV_KIT` const, exactly as `loadDevHostClient` above, so Bun
 * folds it and `DevKitPanel` leaves the static bundle. This is the only edge from
 * `game/` to `ui/`; it is a dynamic import that the static build strips entirely, and
 * exists only in the dev build.
 */
export function loadDevKitPanel(): Promise<DevKitPanelModule> | null {
  if (DEV_KIT) {
    return import("../ui/DevKitPanel");
  }
  return null;
}
