/**
 * The app shell. A useEffect builds the run controller, runs it on mount, and
 * disposes it on unmount, so render never drives the pipeline. React Strict Mode's
 * mount/unmount/mount cycle is safe: each effect builds a fresh controller and the
 * cleanup disposes it. The Run button reloads the current Algorithm source.
 *
 * A second, dev-only effect wires the local-IDE (algorithms hot-reload) client. Its
 * whole path is gated on `import.meta.env.DEV` and a live HMR channel, so the
 * production build inlines the gate to `false` and strips both the client and its
 * loader out entirely; under test there is no `import.meta.hot`, so it stays inert
 * too. That client maps a watched save into the run and drives the store's generic
 * `sourceLocked` while a local file is authoritative.
 *
 * Tests inject a controller through `controller`, so the app never loads the real
 * loader or engine under test.
 */
import { ReactFlowProvider } from "@xyflow/react";
import { useEffect, useRef, useState } from "react";
import type { AlgorithmsDevClient } from "../game/algorithms-dev-client";
import { devHotChannel, loadAlgorithmsDevClient } from "../game/algorithms-dev-flag";
import { localAlgorithmUrl } from "../game/algorithms-resolve";
import { createRunController, type RunController } from "../game/run-controller";
import { getGraph, useGameStore } from "../game/store";
import { kioskPinAttack } from "../sim/scenarios/kiosk-pin-attack/scenario";
import { AlgorithmEditor } from "./AlgorithmEditor";
import { Briefing } from "./Briefing";
import { ChaosLadder } from "./ChaosLadder";
import { chaosLevels, hireMe, introCopy, liveScenario, REPO_URL } from "./content/narrative";
import { HireMe } from "./HireMe";
import { Hud } from "./hud/Hud";
import { IntroOverlay } from "./IntroOverlay";
import { hasSeenIntro, markIntroSeen } from "./onboarding-storage";
import { Pipeline } from "./Pipeline";
import { scenarioSlug } from "./scenarios";

function buildController(): RunController {
  return createRunController({
    scenario: kioskPinAttack,
    getGraph,
    // The one discriminated input. A local override (set by the dev-only algorithms
    // client) drives url mode; otherwise the in-game editor drives source mode.
    getAlgorithmSource: () => {
      const state = useGameStore.getState();
      if (state.localAlgorithm !== null) {
        const { path, version } = state.localAlgorithm;
        return { kind: "url", path, version, url: localAlgorithmUrl(path, version) };
      }
      return { kind: "source", source: state.source };
    },
    getSeed: () => useGameStore.getState().seed,
    setSnapshot: useGameStore.getState().setSnapshot,
    setError: useGameStore.getState().setError,
  });
}

interface AppProps {
  controller?: RunController;
}

export function App({ controller }: AppProps = {}) {
  const controllerRef = useRef<RunController | null>(null);

  // The dev-only local-IDE (algorithms hot-reload) client. Its whole path is gated on
  // `import.meta.env.DEV` and a live HMR channel, so it never mounts in the production
  // build or under test (no `import.meta.hot`).
  const algoClientRef = useRef<AlgorithmsDevClient | null>(null);
  const [algoReady, setAlgoReady] = useState(false);
  const [localMode, setLocalMode] = useState(false);

  // The intro overlay. The seen flag is read once, in a lazy initializer, so the
  // overlay decision is made before first paint. `scrollTarget` holds a deferred
  // anchor id: a dismissing action sets it, then an effect scrolls to it after the
  // overlay has unmounted, so the scroll always lands on the mounted shell.
  const [introOpen, setIntroOpen] = useState(() => !hasSeenIntro());
  const [scrollTarget, setScrollTarget] = useState<string | null>(null);
  const reopenRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);

  // Dismiss the overlay. Every dismissing action marks the intro seen and, when it
  // carries a scroll target, defers the scroll to after the overlay unmounts. A
  // storage failure never blocks the close, since the wrapper swallows it.
  const dismissIntro = (target: string | null): void => {
    markIntroSeen();
    setScrollTarget(target);
    returnFocus.current = true;
    setIntroOpen(false);
  };

  // Run the deferred scroll and the focus return after the overlay unmounts. Reading
  // the anchor here, not at click time, is what keeps the scroll off the overlay.
  useEffect(() => {
    if (introOpen) {
      return;
    }
    if (scrollTarget !== null) {
      document.getElementById(scrollTarget)?.scrollIntoView({ behavior: "smooth", block: "start" });
      setScrollTarget(null);
    }
    if (returnFocus.current) {
      reopenRef.current?.focus();
      returnFocus.current = false;
    }
  }, [introOpen, scrollTarget]);

  const slug = scenarioSlug(kioskPinAttack.id);

  useEffect(() => {
    const active = controller ?? buildController();
    controllerRef.current = active;
    active.run();
    return () => {
      active.dispose();
      controllerRef.current = null;
    };
  }, [controller]);

  // Build the dev-only local-IDE client on mount, behind the folded `import.meta.env.DEV`
  // gate and a live HMR channel. On a forced reload (Vite reloads when the active file is
  // deleted) the persisted snapshot re-enters local mode automatically. Dispose on unmount
  // keeps the snapshot, so a reload can still resume.
  useEffect(() => {
    if (!import.meta.env.DEV) {
      return;
    }
    const channel = devHotChannel();
    if (channel === null) {
      return; // no dev server (production build, or the test environment): no local mode
    }
    const loader = loadAlgorithmsDevClient();
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
          slug,
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
  }, [slug]);

  const onEnterLocalMode = (): void => {
    algoClientRef.current?.enter();
    setLocalMode(true);
  };

  const onStopLocalMode = (): void => {
    algoClientRef.current?.stop();
    controllerRef.current?.run(); // the restored in-game source drives the run again
    setLocalMode(false);
  };

  return (
    <div className="app">
      <header className="topbar">
        <h1>Detection Express</h1>
        <span className="slice-tag">Slice 1 &mdash; Spot the threat</span>
        <div className="topbar-actions">
          <button
            type="button"
            ref={reopenRef}
            className="topbar-reopen"
            onClick={() => setIntroOpen(true)}
          >
            How this works
          </button>
          <HireMe copy={hireMe} />
        </div>
      </header>
      <Hud />
      <ReactFlowProvider>
        <Pipeline />
      </ReactFlowProvider>
      <Briefing tagline={liveScenario.tagline} text={kioskPinAttack.briefing} />
      <AlgorithmEditor onRun={() => controllerRef.current?.run()} slug={slug} />
      <ChaosLadder levels={chaosLevels} liveScenario={liveScenario} />
      {introOpen ? (
        <IntroOverlay
          copy={introCopy}
          repoUrl={REPO_URL}
          onObserve={() => dismissIntro(null)}
          onCauseChaos={() => dismissIntro("chaos-ladder")}
          onEditEngine={() => dismissIntro("algorithm-editor")}
        />
      ) : null}
      {algoReady ? (
        <div className="local-ide">
          {localMode ? (
            <button type="button" onClick={onStopLocalMode}>
              Stop editing
            </button>
          ) : (
            <button type="button" onClick={onEnterLocalMode}>
              Edit in IDE
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
