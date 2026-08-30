/**
 * The app shell. It holds a `view` toggle (`"pipeline"` or `"metro"`) and one
 * conditional effect per mode: each builds a FRESH controller from its factory when
 * that mode becomes visible and disposes it (permanently) on hide, so only the
 * visible mode's loop runs. React Strict Mode's mount/unmount/mount cycle is safe:
 * the factory yields a new controller per epoch and the cleanup disposes the old one.
 * Render never drives either loop. The Apply button reloads the current Algorithm
 * source.
 *
 * A second, dev-only effect wires the local-IDE (algorithms hot-reload) client. Its
 * whole path is gated on `import.meta.env.DEV` and a live HMR channel, so the
 * production build inlines the gate to `false` and strips both the client and its
 * loader out entirely; under test there is no `import.meta.hot`, so it stays inert
 * too. That client maps a watched save into the run and drives the store's generic
 * `sourceLocked` while a local file is authoritative. It lives in its own effect, so
 * a mode switch never tears the dev client down or reconnects it.
 *
 * Tests inject controller factories through `createPipelineController` /
 * `createWorldController`, so the app never loads the real loader or engine under test.
 */
import { useEffect, useRef, useState } from "react";
import type { AlgorithmsDevClient } from "../game/algorithms-dev-client";
import { devHotChannel, loadAlgorithmsDevClient } from "../game/algorithms-dev-flag";
import { localAlgorithmUrl } from "../game/algorithms-resolve";
import { createRunController, type RunController } from "../game/run-controller";
import { getGraph, useGameStore } from "../game/store";
import { createWorldRunController, type WorldRunController } from "../game/world-run-controller";
import { useWorldStore, worldSpeed } from "../game/world-store";
import { kioskPinAttack } from "../sim/scenarios/kiosk-pin-attack/scenario";
import { distanceTable } from "../sim/world/distance";
import { world } from "../sim/world/world";
import { AlgorithmEditor } from "./AlgorithmEditor";
import { Briefing } from "./Briefing";
import { ChaosLadder } from "./ChaosLadder";
import { chaosLevels, hireMe, introCopy, liveScenario, REPO_URL } from "./content/narrative";
import { InspectorShell } from "./findings/InspectorShell";
import { HireMe } from "./HireMe";
import { Hud } from "./hud/Hud";
import { IntroOverlay } from "./IntroOverlay";
import { MetroView } from "./MetroView";
import { hasSeenIntro, markIntroSeen } from "./onboarding-storage";
import { scenarioSlug } from "./scenarios";

/** Which mode is on screen. Only the visible mode's loop runs. */
type View = "pipeline" | "metro";

/** The station distances are fixed data, built once for the world controller. */
const worldDistances = distanceTable(world);

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
    setRunPending: useGameStore.getState().setRunPending,
  });
}

function buildWorldController(): WorldRunController {
  return createWorldRunController({
    // The controller derives the timetable and builds the four trains (T1..T4) as
    // persistent fixtures; there are no other fixtures yet (M6 adds operators and hosts).
    world,
    distances: worldDistances,
    getFixtures: () => [],
    getSeed: () => useGameStore.getState().seed,
    setWorldSnapshot: useWorldStore.getState().setWorldSnapshot,
    getSpeed: worldSpeed,
  });
}

interface AppProps {
  // Controller FACTORIES: each mode builds a FRESH controller when it becomes visible
  // and disposes it on hide (disposal is permanent). Tests inject stub factories.
  createPipelineController?: () => RunController;
  createWorldController?: () => WorldRunController;
}

export function App({ createPipelineController, createWorldController }: AppProps = {}) {
  const [view, setView] = useState<View>("pipeline");
  const controllerRef = useRef<RunController | null>(null);

  // The dev-only local-IDE (algorithms hot-reload) client. Its whole path is gated on
  // `import.meta.env.DEV` and a live HMR channel, so it never mounts in the production
  // build or under test (no `import.meta.hot`).
  const algoClientRef = useRef<AlgorithmsDevClient | null>(null);
  const [algoReady, setAlgoReady] = useState(false);
  const [localMode, setLocalMode] = useState(false);

  // The intro overlay. The seen flag is read once, in a lazy initializer, so the
  // overlay decision is made before first paint. A dismissing action records its
  // intent in a ref, then an effect acts on it after the overlay has unmounted, so
  // the scroll always lands on the mounted shell. The intent lives in a ref, not
  // state, so the effect runs once per dismiss and never re-triggers itself.
  const [introOpen, setIntroOpen] = useState(() => !hasSeenIntro());
  const reopenRef = useRef<HTMLButtonElement>(null);
  const pendingDismiss = useRef<{ scrollTarget: string | null } | null>(null);

  // Dismiss the overlay. Every dismissing action marks the intro seen and records its
  // scroll target for the post-close effect. A storage failure never blocks the close,
  // since the wrapper swallows it.
  const dismissIntro = (target: string | null): void => {
    markIntroSeen();
    pendingDismiss.current = { scrollTarget: target };
    setIntroOpen(false);
  };

  // After the overlay unmounts, act on the recorded dismiss intent exactly once.
  // A scroll action scrolls to its target, then moves focus there without a second
  // scroll. Observe and Escape carry no target, so focus returns to the reopen
  // control. Reading the anchor here, not at click time, keeps the scroll off the
  // overlay.
  useEffect(() => {
    if (introOpen) {
      return;
    }
    const pending = pendingDismiss.current;
    if (pending === null) {
      return;
    }
    pendingDismiss.current = null;
    if (pending.scrollTarget !== null) {
      const target = document.getElementById(pending.scrollTarget);
      target?.scrollIntoView({ behavior: "smooth", block: "start" });
      target?.focus({ preventScroll: true });
    } else {
      reopenRef.current?.focus({ preventScroll: true });
    }
  }, [introOpen]);

  const slug = scenarioSlug(kioskPinAttack.id);

  // The pipeline controller lifecycle, conditional on the pipeline view. A fresh
  // controller per visible epoch; the cleanup disposes it (permanently) on hide or
  // unmount, including React strict-mode's mount/unmount/mount cycle.
  useEffect(() => {
    if (view !== "pipeline") {
      return;
    }
    const active = (createPipelineController ?? buildController)();
    controllerRef.current = active;
    active.run();
    // Seed the fresh controller from the store's transport. The reflection effects are
    // keyed on [frozen]/[speed], so they do not re-fire on a view change; without this
    // seed a Metro->Pipeline round-trip would run the new engine unfrozen at 1x while
    // the panel still shows frozen/2x.
    active.setFrozen(useGameStore.getState().transport.frozen);
    active.setSpeed(useGameStore.getState().transport.speed);
    return () => {
      active.dispose();
      if (controllerRef.current === active) {
        controllerRef.current = null;
      }
    };
  }, [view, createPipelineController]);

  // The world controller lifecycle, conditional on the metro view. Same fresh-per-epoch
  // rule; a mode switch disposes the hidden mode's loop and builds the shown one's.
  useEffect(() => {
    if (view !== "metro") {
      return;
    }
    const active = (createWorldController ?? buildWorldController)();
    active.run();
    return () => {
      active.dispose();
    };
  }, [view, createWorldController]);

  // Reflect the store's transport mirror into the pipeline controller. This handles a
  // user toggle from the panel. An engine swap (mount, Apply, hot-reload) is handled by
  // the controller reapplying its retained state on startEngine, which this effect
  // misses because the store value did not change. The two guards together drop no
  // state. `controllerRef` holds the pipeline controller, which is live only in the
  // pipeline view; in the metro view the ref is null and the reflection is a no-op.
  const frozen = useGameStore((s) => s.transport.frozen);
  useEffect(() => {
    controllerRef.current?.setFrozen(frozen);
  }, [frozen]);

  // The same reflection for speed. A panel speed change flows here; an engine swap is
  // handled by the controller reapplying its retained speed on startEngine.
  const speed = useGameStore((s) => s.transport.speed);
  useEffect(() => {
    controllerRef.current?.setSpeed(speed);
  }, [speed]);

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
      {/* The shell. While the intro overlay is open it is `inert`, so a screen
          reader's virtual cursor and the keyboard cannot reach it and the overlay
          is truly modal. The overlay is a sibling of this container, so it stays
          interactive. */}
      <div className="app-shell" inert={introOpen}>
        <header className="topbar">
          <h1>Detection Express</h1>
          <span className="slice-tag">Observe the Engine, then cause chaos</span>
          <div className="topbar-actions">
            <button
              type="button"
              className="view-toggle"
              onClick={() => setView(view === "pipeline" ? "metro" : "pipeline")}
            >
              {view === "pipeline" ? "Metro view" : "Pipeline view"}
            </button>
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
        {view === "pipeline" ? (
          <>
            <Hud />
            <InspectorShell />
            <Briefing tagline={liveScenario.tagline} text={kioskPinAttack.briefing} />
            <AlgorithmEditor onRun={() => controllerRef.current?.run()} slug={slug} />
            <ChaosLadder levels={chaosLevels} liveScenario={liveScenario} />
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
          </>
        ) : (
          <MetroView />
        )}
      </div>
      {introOpen ? (
        <IntroOverlay
          copy={introCopy}
          repoUrl={REPO_URL}
          onObserve={() => dismissIntro(null)}
          onCauseChaos={() => dismissIntro("chaos-ladder")}
          onEditEngine={() => dismissIntro("algorithm-editor")}
        />
      ) : null}
    </div>
  );
}
