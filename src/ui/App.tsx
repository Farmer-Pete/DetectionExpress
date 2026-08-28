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
}

export function App({ controller, createDevClient }: AppProps = {}) {
  const controllerRef = useRef<RunController | null>(null);
  const devClientRef = useRef<DevHostClient | null>(null);
  const devFactoryRef = useRef<DevClientFactory | null>(null);
  const startClientRef = useRef<((factory: DevClientFactory) => void) | null>(null);
  const loadClientRef = useRef<(() => void) | null>(null);
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

  useEffect(() => {
    const active = controller ?? buildController();
    controllerRef.current = active;
    active.run();

    let cancelled = false;

    const startClient = (factory: DevClientFactory): void => {
      if (cancelled) {
        return;
      }
      try {
        const client = factory(buildDeps());
        devClientRef.current = client;
        // Remember the factory only once a client is built, so a build that threw
        // leaves it null and `ensureClient` re-runs the load rather than the dead factory.
        devFactoryRef.current = factory;
        client.connect();
      } catch {
        reportDev({ status: "error", path: null, message: "The dev host is unavailable." });
      }
    };
    startClientRef.current = startClient;

    // Load and start the client. Injected in tests through `createDevClient`; otherwise
    // a lazy import whose gate is co-located with the flag const, so `dev-host-client`
    // is stripped from the static build. Re-runnable, so a later "Edit in my IDE" can
    // retry after a failed load or build (the factory stays null until one succeeds).
    const loadAndStart = (): void => {
      if (cancelled) {
        return;
      }
      if (createDevClient) {
        startClient(createDevClient);
        return;
      }
      const pending = loadDevHostClient();
      if (pending !== null) {
        pending
          .then((mod) => startClient(mod.createDevHostClient))
          .catch(() => {
            if (!cancelled) {
              reportDev({
                status: "error",
                path: null,
                message: "The dev host client failed to load.",
              });
            }
          });
      }
    };
    loadClientRef.current = loadAndStart;

    loadAndStart();

    return () => {
      cancelled = true;
      active.dispose();
      controllerRef.current = null;
      devClientRef.current?.disconnect();
      devClientRef.current = null;
      startClientRef.current = null;
      loadClientRef.current = null;
    };
  }, [controller, createDevClient, buildDeps, reportDev]);

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

  // Make sure a client exists before an edit. A "Stop editing" drops the client but
  // keeps the known-good factory, so rebuild from it. A failed initial load or build
  // leaves the factory null, so re-run the load (retrying the dynamic import) instead
  // of no-opping forever.
  const ensureClient = (): void => {
    if (devClientRef.current !== null) {
      return;
    }
    const factory = devFactoryRef.current;
    const start = startClientRef.current;
    if (factory !== null && start !== null) {
      start(factory);
    } else {
      loadClientRef.current?.();
    }
  };

  const onEditInIde = (): void => {
    ensureClient();
    const client = devClientRef.current;
    if (client === null) {
      return;
    }
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

  const onStopEditing = (): void => {
    devClientRef.current?.disconnect();
    devClientRef.current = null;
    useGameStore.getState().setSourceLocked(false);
    reportDev({ status: "off", path: null, message: null });
  };

  const devEnabled = DEV_KIT || createDevClient !== undefined;

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
