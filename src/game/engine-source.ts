/**
 * The in-game editor's default source: the assembled single engine, as one readable
 * JS string. It is produced by the `assemble-engine` Vite plugin and served as the
 * `virtual:engine-source` module, so the same assembled source shows in the dev editor
 * and ships in the production build.
 *
 * This thin re-export is the seam the app and the store import, so the bundler-virtual
 * module reference lives here in `game/` and never leaks into `sim/` (which stays free
 * of bundler coupling).
 */
import { engineSource } from "virtual:engine-source";

/** The editor's default text and the source the browser run loads. */
export const referenceSource: string = engineSource;
