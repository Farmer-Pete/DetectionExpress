/**
 * The world run controller: the metro's start/stop glue, a sibling to
 * `run-controller.ts`. `App` (from M1) calls a factory for a fresh controller when
 * the metro mode becomes visible and disposes it on hide; disposal is permanent, so
 * a re-shown mode builds a new one. For M0 it is exercised by tests only.
 *
 * It is synchronous: the world loop has no async load or profile, so `run` stops any
 * prior engine, clears the snapshot, and starts a fresh world engine over the
 * current fixtures and seed. Every dependency is injectable, so tests never spawn a
 * real clock.
 */

import type { WorldEnv } from "../sim/world-reading";
import { emptyWorldSnapshot, type WorldSnapshot } from "../sim/world-snapshot";
import {
  startWorld as startWorldDefault,
  type WorldEngineHandle,
  type WorldFixture,
  type WorldStartOptions,
} from "./world-engine";

export interface WorldRunController {
  /** Stop any prior engine and start a fresh one. Safe to call repeatedly. */
  run(): void;
  /** Permanent teardown. A later `run` sees this and does nothing. */
  dispose(): void;
}

export interface WorldRunControllerDeps {
  getFixtures: () => readonly WorldFixture[];
  env: WorldEnv;
  getSeed: () => number;
  setWorldSnapshot: (snapshot: WorldSnapshot) => void;
  /** Defaults to the real world engine; tests inject a fake. */
  start?: (options: WorldStartOptions) => WorldEngineHandle;
  /** Reports a loop failure. */
  onError?: (error: unknown) => void;
  /** Called when a live run tears down on its own. */
  onFinished?: () => void;
}

export function createWorldRunController(deps: WorldRunControllerDeps): WorldRunController {
  const startEngine = deps.start ?? startWorldDefault;

  let engine: WorldEngineHandle | null = null;
  let disposed = false;

  const run = (): void => {
    if (disposed) {
      return;
    }
    engine?.stop(); // sync + idempotent
    deps.setWorldSnapshot(emptyWorldSnapshot());
    const handle = startEngine({
      fixtures: deps.getFixtures(),
      env: deps.env,
      runSeed: deps.getSeed(),
      setWorldSnapshot: deps.setWorldSnapshot,
      onError: (error) => deps.onError?.(error),
    });
    engine = handle;
    // A disposed completion is ignored; a stale handle sees `engine` moved on.
    void handle.whenStopped.then(() => {
      if (!disposed && engine === handle) {
        deps.onFinished?.();
      }
    });
  };

  const dispose = (): void => {
    disposed = true;
    engine?.stop();
  };

  return { run, dispose };
}
