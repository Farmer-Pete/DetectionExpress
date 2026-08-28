/**
 * The app shell. A useEffect builds the run controller, runs it on mount, and
 * disposes it on unmount, so render never drives the pipeline. React Strict Mode's
 * mount/unmount/mount cycle is safe: each effect builds a fresh controller and the
 * cleanup disposes it. The Run button reloads the current Algorithm source.
 *
 * Under the `DEV_KIT` build flag the same effect also builds the dev-host client and
 * wires it: it connects on mount and disconnects on cleanup, maps the client's state
 * to the store's generic `sourceLocked`, and pushes each watched save into the run.
 * The client and the `DevKitPanel` are both loaded by a dynamic `import` behind the
 * folded `DEV_KIT` gate, so neither is a static input to the CDN build and both drop
 * out entirely when `DEV_KIT` is false.
 *
 * The App is the state hub: the client's `onState` sets the store lock (an App
 * concern) and forwards the richer dev state to the panel through `subscribe`. "Stop
 * editing" disconnects the client and drops the ref; the next "Edit in my IDE"
 * rebuilds a fresh client, so reconnecting after a stop still works.
 *
 * Tests inject a controller through `controller` and a dev-client factory through
 * `createDevClient`, so the app never loads the real loader, engine, or EventSource
 * under test.
 */
import { ReactFlowProvider } from "@xyflow/react";
import { type FunctionComponent, useCallback, useEffect, useRef, useState } from "react";
import { DEV_KIT, loadDevHostClient, loadDevKitPanel } from "../game/dev-flag";
import type { DevHostClient, DevHostClientDeps, DevState } from "../game/dev-host-client";
import { createRunController, type RunController } from "../game/run-controller";
import { getGraph, useGameStore } from "../game/store";
import { referenceSource } from "../sim/scenarios/kiosk-pin-attack/reference";
import { kioskPinAttack } from "../sim/scenarios/kiosk-pin-attack/scenario";
import { AlgorithmEditor } from "./AlgorithmEditor";
import { Briefing } from "./Briefing";
import type { DevKitPanelProps } from "./DevKitPanel";
import { Hud } from "./hud/Hud";
import { Pipeline } from "./Pipeline";
import { scenarioSlug } from "./scenarios";

/** Builds a dev-host client from the deps the App wires. Injected in tests. */
type DevClientFactory = (deps: DevHostClientDeps) => DevHostClient;

function buildController(): RunController {
  return createRunController({
    scenario: kioskPinAttack,
    getGraph,
    getSource: () => useGameStore.getState().source,
    getSeed: () => useGameStore.getState().seed,
    setSnapshot: useGameStore.getState().setSnapshot,
    setError: useGameStore.getState().setError,
  });
}

interface AppProps {
  controller?: RunController;
  createDevClient?: DevClientFactory;
  // A test seam for the ASYNC load path: an injectable loader that resolves the
  // factory over a promise, mirroring the real dynamic import. Production leaves it
  // unset and uses `loadDevHostClient`.
  loadDevClient?: () => Promise<DevClientFactory>;
}

export function App({ controller, createDevClient, loadDevClient }: AppProps = {}) {
  const controllerRef = useRef<RunController | null>(null);
  const devClientRef = useRef<DevHostClient | null>(null);
  const devFactoryRef = useRef<DevClientFactory | null>(null);
  const startClientRef = useRef<((factory: DevClientFactory) => DevHostClient | null) | null>(null);
  const loadClientRef = useRef<(() => Promise<DevHostClient | null>) | null>(null);
  // The in-flight client load, so a second "Edit in my IDE" click during a load
  // reuses it instead of building a second client (which would leak an EventSource).
  const pendingClientRef = useRef<Promise<DevHostClient | null> | null>(null);
  const devSubscriberRef = useRef<((state: DevState) => void) | null>(null);
  const lastDevStateRef = useRef<DevState | null>(null);
  const [Panel, setPanel] = useState<FunctionComponent<DevKitPanelProps> | null>(null);

  const slug = scenarioSlug(kioskPinAttack.id);

  // Cache the last dev state and forward it to the current subscriber. A state emitted
  // before the async DevKitPanel has subscribed would otherwise be dropped, leaving the
  // panel stuck in its off state; the cache lets `subscribe` replay it on arrival.
  const reportDev = useCallback((state: DevState): void => {
    lastDevStateRef.current = state;
    devSubscriberRef.current?.(state);
  }, []);

  const buildDeps = useCallback(
    (): DevHostClientDeps => ({
      scenarioSlug: slug,
      applySource: (text: string): void => {
        useGameStore.getState().setAlgorithmSource(text);
        controllerRef.current?.run();
      },
      onState: (state: DevState): void => {
        useGameStore.getState().setSourceLocked(state.path !== null);
        reportDev(state);
      },
    }),
    [slug, reportDev],
  );

  const subscribeDevState = useCallback((listener: (state: DevState) => void): (() => void) => {
    devSubscriberRef.current = listener;
    // Replay the cached state so a panel that subscribes after the event still sees it.
    if (lastDevStateRef.current !== null) {
      listener(lastDevStateRef.current);
    }
    return () => {
      if (devSubscriberRef.current === listener) {
        devSubscriberRef.current = null;
      }
    };
  }, []);

  // Record the in-flight client load so a concurrent `ensureClient` reuses it, and
  // clear it once it settles. Stable, so it can be an effect dependency.
  const trackPending = useCallback(
    (promise: Promise<DevHostClient | null>): Promise<DevHostClient | null> => {
      pendingClientRef.current = promise;
      const clear = (): void => {
        if (pendingClientRef.current === promise) {
          pendingClientRef.current = null;
        }
      };
      promise.then(clear, clear);
      return promise;
    },
    [],
  );

  useEffect(() => {
    const active = controller ?? buildController();
    controllerRef.current = active;
    active.run();

    let cancelled = false;

    const startClient = (factory: DevClientFactory): DevHostClient | null => {
      if (cancelled) {
        return null;
      }
      try {
        const client = factory(buildDeps());
        devClientRef.current = client;
        // Remember the factory only once a client is built, so a build that threw
        // leaves it null and `ensureClient` re-runs the load rather than the dead factory.
        devFactoryRef.current = factory;
        client.connect();
        return client;
      } catch {
        reportDev({ status: "error", path: null, message: "The dev host is unavailable." });
        return null;
      }
    };
    startClientRef.current = startClient;

    // The async factory source: an injected loader (tests), or the real dynamic import
    // whose gate is co-located with the flag const so `dev-host-client` is stripped from
    // the static build. Returns null when the dev kit is off.
    const loadFactory = (): Promise<DevClientFactory> | null => {
      if (loadDevClient) {
        return loadDevClient();
      }
      const pending = loadDevHostClient();
      return pending === null ? null : pending.then((mod) => mod.createDevHostClient);
    };

    // Load and start the client, resolving to the built client (or null on failure).
    // Re-runnable, so a later "Edit in my IDE" can retry after a failed load or build
    // (the factory stays null until one succeeds). The injected sync `createDevClient`
    // builds synchronously so a mount-time connect is observable to tests.
    const loadAndStart = (): Promise<DevHostClient | null> => {
      if (cancelled) {
        return Promise.resolve(null);
      }
      if (createDevClient) {
        return Promise.resolve(startClient(createDevClient));
      }
      const factoryPromise = loadFactory();
      if (factoryPromise === null) {
        return Promise.resolve(null);
      }
      return factoryPromise
        .then((factory) => startClient(factory))
        .catch(() => {
          if (!cancelled) {
            reportDev({
              status: "error",
              path: null,
              message: "The dev host client failed to load.",
            });
          }
          return null;
        });
    };
    loadClientRef.current = loadAndStart;

    trackPending(loadAndStart());

    return () => {
      cancelled = true;
      active.dispose();
      controllerRef.current = null;
      devClientRef.current?.disconnect();
      devClientRef.current = null;
      startClientRef.current = null;
      loadClientRef.current = null;
      pendingClientRef.current = null;
    };
  }, [controller, createDevClient, loadDevClient, buildDeps, reportDev, trackPending]);

  // Load the dev panel the same folded-gate way, so it never enters the static build.
  useEffect(() => {
    const pending = loadDevKitPanel();
    if (pending === null) {
      return;
    }
    let cancelled = false;
    pending
      .then((mod) => {
        if (!cancelled) {
          setPanel(() => mod.DevKitPanel);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Make sure a client exists before an edit, resolving to it. A "Stop editing" drops
  // the client but keeps the known-good factory, so rebuild from it synchronously. A
  // failed initial load or build leaves the factory null, so re-run the load (retrying
  // the dynamic import). An in-flight load is reused, so one extra click cannot build a
  // second client.
  const ensureClient = (): Promise<DevHostClient | null> => {
    if (devClientRef.current !== null) {
      return Promise.resolve(devClientRef.current);
    }
    if (pendingClientRef.current !== null) {
      return pendingClientRef.current;
    }
    const factory = devFactoryRef.current;
    const start = startClientRef.current;
    const load = loadClientRef.current;
    if (factory !== null && start !== null) {
      return trackPending(Promise.resolve(start(factory)));
    }
    if (load !== null) {
      return trackPending(load());
    }
    return Promise.resolve(null);
  };

  const openWith = (client: DevHostClient): void => {
    client.editInIde(slug, referenceSource).catch((error: unknown) => {
      // Surface the dev host's specific reason (cap, invalid name, symlink) when it
      // gave one, falling back to a generic line only when it did not.
      const message =
        error instanceof Error && error.message.length > 0
          ? error.message
          : "Could not open the Scenario file.";
      reportDev({ status: "error", path: null, message });
    });
  };

  const onEditInIde = (): void => {
    const pending = ensureClient();
    // A known-good factory builds synchronously, so the client is ready now: open at
    // once (keeps the click fully synchronous). Otherwise the load is async (a dynamic
    // import); await it so one click after a failed load both reconnects AND opens,
    // instead of the old two-click behavior.
    if (devClientRef.current !== null) {
      openWith(devClientRef.current);
      return;
    }
    pending.then((client) => {
      if (client !== null) {
        openWith(client);
      }
    });
  };

  const onStopEditing = (): void => {
    devClientRef.current?.disconnect();
    devClientRef.current = null;
    useGameStore.getState().setSourceLocked(false);
    reportDev({ status: "off", path: null, message: null });
  };

  const devEnabled = DEV_KIT || createDevClient !== undefined || loadDevClient !== undefined;

  return (
    <div className="app">
      <header className="topbar">
        <h1>Detection Express</h1>
        <span className="slice-tag">Slice 1 &mdash; Spot the threat</span>
      </header>
      <Hud />
      <ReactFlowProvider>
        <Pipeline />
      </ReactFlowProvider>
      <Briefing text={kioskPinAttack.briefing} />
      <AlgorithmEditor onRun={() => controllerRef.current?.run()} slug={slug} />
      {devEnabled && Panel !== null ? (
        <Panel
          onEditInIde={onEditInIde}
          onStopEditing={onStopEditing}
          subscribe={subscribeDevState}
        />
      ) : null}
    </div>
  );
}
