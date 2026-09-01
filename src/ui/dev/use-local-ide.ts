/**
 * The dev-only local-IDE (algorithms hot-reload) client, extracted from `App.tsx`
 * (GH109-PLAN.md). Its whole path is gated on `import.meta.env.DEV` and a live HMR
 * channel, so it never mounts in the production build or under test (no
 * `import.meta.hot`). On a forced reload (Vite reloads when the active file is
 * deleted) the persisted snapshot re-enters local mode automatically. Dispose on
 * unmount keeps the snapshot, so a reload can still resume.
 *
 * Named `useLocalIde`, not `useAlgorithmsDevClient`: `verify:static` fails the build
 * if a production module id contains `"algorithms-dev-client"`, and unlike the real
 * dev client and its loader (both dynamically imported behind the DEV gate), this
 * hook module is imported unconditionally by `App`, so it stays in the production
 * chunk graph. A filename carrying that marker would fail the check even though the
 * dev client itself still tree-shakes out (see GH109-PLAN.md's naming note).
 */

import type { RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import type {
  AlgorithmsDevClient,
  AlgorithmsDevClientModule,
  HotChannelLike,
} from "../../game/algorithms-dev-client";
import { devHotChannel, loadAlgorithmsDevClient } from "../../game/algorithms-dev-flag";
import type { RunController } from "../../game/run-controller";
import { useGameStore } from "../../game/store";

export interface UseLocalIdeArgs {
  controllerRef: RefObject<RunController | null>;
  /** Test injection for the HMR-channel gate. Defaults to the real `devHotChannel`,
      which reads `import.meta.hot` and always returns null outside a live Vite dev
      server, so this is the seam a test uses to exercise the channel-present path
      with a fake channel instead of a real one. `| undefined` is explicit so a
      caller under exactOptionalPropertyTypes (this repo, tsconfig) can pass an
      optional prop value that may itself be undefined, matching the ModalHost and
      controller-hook convention. */
  getChannel?: (() => HotChannelLike | null) | undefined;
  /** Test injection for the dev-client loader. Defaults to the real
      `loadAlgorithmsDevClient`. A test supplies a resolved or rejected promise
      wrapping a fake `createAlgorithmsDevClient`, so the whole effect body runs
      against dependency injection rather than a mocked module. */
  loadClient?: (() => Promise<AlgorithmsDevClientModule> | null) | undefined;
}

export interface LocalIdeState {
  algoReady: boolean;
  localMode: boolean;
  onEnterLocalMode: () => void;
  onStopLocalMode: () => void;
}

export function useLocalIde({
  controllerRef,
  getChannel,
  loadClient,
}: UseLocalIdeArgs): LocalIdeState {
  const algoClientRef = useRef<AlgorithmsDevClient | null>(null);
  const [algoReady, setAlgoReady] = useState(false);
  const [localMode, setLocalMode] = useState(false);

  // Build the dev-only local-IDE client on mount, behind the folded `import.meta.env.DEV`
  // gate and a live HMR channel. The gate is the effect's first statement and the dynamic
  // `loadAlgorithmsDevClient()` import stays behind it, so Vite folds the gate to `false`
  // in the production build and strips both out entirely; the test environment has no
  // `import.meta.hot`, so it stays inert too.
  // biome-ignore lint/correctness/useExhaustiveDependencies: controllerRef is a stable ref object (usePipelineController's useRef, passed through), so its identity never changes across renders; this hook only reads controllerRef.current at call time inside the closure, exactly the ref-stability pattern FindingsPanel.tsx's panelRef effect already carries this same suppression for.
  useEffect(() => {
    if (!import.meta.env.DEV) {
      return;
    }
    const channel = (getChannel ?? devHotChannel)();
    if (channel === null) {
      return; // no dev server (production build, or the test environment): no local mode
    }
    const loader = (loadClient ?? loadAlgorithmsDevClient)();
    if (loader === null) {
      return;
    }
    let cancelled = false;
    loader
      .then((mod) => {
        if (cancelled) {
          return;
        }
        const client = mod.createAlgorithmsDevClient({
          channel,
          store: {
            getSource: () => useGameStore.getState().source,
            setSource: (source) => useGameStore.getState().setAlgorithmSource(source),
            setLocalAlgorithm: (value) => useGameStore.getState().setLocalAlgorithm(value),
            setSourceLocked: (locked) => useGameStore.getState().setSourceLocked(locked),
          },
          run: () => controllerRef.current?.run(),
          session: window.sessionStorage,
        });
        algoClientRef.current = client;
        if (client.resume()) {
          setLocalMode(true); // a forced reload re-entered local mode
        }
        setAlgoReady(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      algoClientRef.current?.dispose();
      algoClientRef.current = null;
    };
  }, [getChannel, loadClient]);

  const onEnterLocalMode = (): void => {
    algoClientRef.current?.enter();
    setLocalMode(true);
  };

  const onStopLocalMode = (): void => {
    algoClientRef.current?.stop();
    controllerRef.current?.run(); // the restored in-game source drives the run again
    setLocalMode(false);
  };

  return { algoReady, localMode, onEnterLocalMode, onStopLocalMode };
}
