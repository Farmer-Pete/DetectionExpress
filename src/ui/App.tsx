/**
 * The app shell: thin wiring over four extracted concerns (GH109-PLAN.md). It holds
 * only the `mapShown` toggle, the wave shake, the modal-open derivation, and the two
 * panel refs shared with `InspectorShell`/`DecisionsPanel`/`TraceOverlay`; everything
 * else is composed from a hook or a component that owns its own lifecycle and its own
 * tests:
 *
 * - `useIntroOverlay` (intro/) owns the overlay's seen-flag state, its three dismiss
 *   actions, and the post-close scroll+focus effect.
 * - `usePipelineController` (run/) builds the one merged-engine `RunController` on
 *   mount and disposes it (permanently) on unmount. React Strict Mode's
 *   mount/unmount/mount cycle is safe: the factory yields a new controller per epoch
 *   and the cleanup disposes the old one. Render never drives the loop. Tests inject
 *   a controller factory through `createPipelineController`, so the app never loads
 *   the real loader or engine under test. The Apply button reloads the current
 *   Algorithm source. GH117 unified the metro map onto this same engine, so there is
 *   only one controller and one loop now — `useWorldController` and its own
 *   `WorldRunController` are retired from the app (their files stay on disk for a
 *   later deletion step; nothing here imports them).
 * - `useLocalIde` (dev/) wires the dev-only local-IDE (algorithms hot-reload) client.
 *   Its whole path is gated on `import.meta.env.DEV` and a live HMR channel, so the
 *   production build inlines the gate to `false` and strips both the client and its
 *   loader out entirely; under test there is no `import.meta.hot`, so it stays inert
 *   too. That client maps a watched save into the run and drives the store's generic
 *   `sourceLocked` while a local file is authoritative.
 * - `Topbar` renders the header: the title, the slice tag, the map show/hide toggle,
 *   the "How this works" reopen button (wired to `useIntroOverlay`'s `reopenRef` and
 *   `onReopen`), and Hire Me.
 *
 * `App` owns `.app` / `.app-shell` only indirectly: `ModalHost` (GH105-PLAN.md) is the
 * component that actually renders them and holds the shell-inert invariant. `App`
 * derives `modalOpen` — `introOpen || traceOpen`, where `traceOpen` is `selection !==
 * null || decisionSelection !== null` — and hands it in along with both overlays,
 * `IntroOverlay` and `TraceOverlay`, as `ModalHost`'s `overlays` prop. Both render as
 * siblings of the inert shell, so a screen reader's browse mode and the keyboard
 * cannot reach shell content behind either one.
 *
 * The shell also owns the wave shake (#38 juice item 1): one-shot ownership
 * (`useWavePhaseEdge`) toggles `.shake` on `.app-shell` for `SHAKE_MS` on the
 * incoming -> active edge, independent of LogPanel's own `.waveflash`. It
 * lands on `.app-shell`, not the outer `.app` wrapper, because the `shake`
 * keyframe's `transform` makes its own element a containing block for any
 * `position: fixed` descendant (F006): `.app-shell` and the overlays are
 * siblings inside `.app` (via `ModalHost`), so shaking `.app-shell` never drags
 * an overlay's fixed backdrop along with it. The shake gates on run conclusion in two
 * places (F004+F006, CodeRabbit review): `useWavePhaseEdge` reads `"calm"`
 * once `snapshot.status` is no longer `"running"`, so a shake never fires off
 * a frozen terminal frame; separately, the render site ANDs the one-shot flag
 * with `status === "running"`, so an ALREADY in-flight shake clears the
 * instant a run concludes, instead of running out its own timer over a frozen
 * frame. A fresh run re-arms the edge once it starts running again.
 */
import { useRef, useState } from "react";
import { defaultEntry } from "../game/registry";
import type { RunController } from "../game/run-controller";
import { useGameStore } from "../game/store";
import { AlgorithmEditor } from "./AlgorithmEditor";
import { Briefing } from "./Briefing";
import { ChaosLadder } from "./ChaosLadder";
import { chaosLevels, liveScenarioFrom } from "./content/narrative";
import { DecisionsPanel } from "./decisions/DecisionsPanel";
import { LocalIdeToggle } from "./dev/LocalIdeToggle";
import { useLocalIde } from "./dev/use-local-ide";
import { InspectorShell } from "./findings/InspectorShell";
import { TraceOverlay } from "./findings/TraceOverlay";
import { Hud } from "./hud/Hud";
import { useIntroOverlay } from "./intro/use-intro-overlay";
import { MetroView } from "./MetroView";
import { ModalHost } from "./ModalHost";
import { usePipelineController } from "./run/use-pipeline-controller";
import { Topbar } from "./Topbar";
import { useOneShotFlag } from "./wave/use-one-shot-flag";
import { useWavePhaseEdge } from "./wave/use-wave-phase-edge";

/** Matches the CSS `shake` keyframes' 0.3s duration (`src/index.css`). */
const SHAKE_MS = 300;

/** The live scenario's display copy, joined from the registry's catalogue entry. */
const liveScenario = liveScenarioFrom(defaultEntry);

interface AppProps {
  // The controller FACTORY: builds a FRESH controller on mount and disposes it on
  // unmount (disposal is permanent). Tests inject a stub factory.
  createPipelineController?: () => RunController;
}

export function App({ createPipelineController }: AppProps = {}) {
  // Whether the embedded metro map region shows (GH117 Part F). Purely a display
  // toggle now: the one merged engine keeps running underneath either way, so
  // flipping it never builds or tears down a controller.
  const [mapShown, setMapShown] = useState(true);
  // Shared with InspectorShell (which passes it to FindingsPanel) and TraceOverlay
  // (which reads it as the finding-mode focus fallback, GH34-35-PLAN.md decision 14).
  // Lifted here from InspectorShell (GH105-PLAN.md) since TraceOverlay no longer lives
  // inside it.
  const findingsPanelRef = useRef<HTMLElement>(null);
  // Shared with DecisionsPanel (which renders it) and TraceOverlay (which reads it as
  // the decision-mode focus fallback, GH34-35-PLAN.md decision 14).
  const decisionsPanelRef = useRef<HTMLElement>(null);

  // The wave shake (#38 juice item 1). `edgeToken` changes exactly once per
  // incoming -> active edge (`useWavePhaseEdge`); skip its initial `0` so mount
  // never shakes. Gated on conclusion, not the transport freeze (F004+F006): while
  // the run is running, the hook sees the live phase; once it has concluded, it sees
  // `"calm"` instead, so the edge cannot fire off a frozen terminal frame.
  const wavePhase = useGameStore((s) => s.snapshot.wave.phase);
  const status = useGameStore((s) => s.snapshot.status);
  const edgeToken = useWavePhaseEdge(status === "running" ? wavePhase : "calm");
  const shaking = useOneShotFlag(edgeToken, SHAKE_MS);

  // Whether the trace dialog is open (GH105-PLAN.md): `selection !== null` OR
  // `decisionSelection !== null` IS "the dialog is open" (GH34-35-PLAN.md decision 2).
  // Feeds ModalHost's modalOpen alongside introOpen, so the shell goes inert whenever
  // either overlay is showing. This derivation is sound only because the store now
  // validates a selection against the live snapshot before storing it (store.ts), so a
  // set selection always implies TraceOverlay actually renders a dialog.
  const selection = useGameStore((s) => s.selection);
  const decisionSelection = useGameStore((s) => s.decisionSelection);
  const traceOpen = selection !== null || decisionSelection !== null;

  // The intro overlay, extracted to its own hook (GH109-PLAN.md): the seen-flag lazy
  // init, the three dismiss actions, the deferred post-close scroll+focus effect, and
  // the reopen control's ref/handler.
  const intro = useIntroOverlay();

  // The pipeline controller lifecycle, extracted to its own hook (GH109-PLAN.md): a
  // fresh controller per epoch, seeded from the store transport, disposed (with the
  // F024 empty-snapshot repaint and cleared selection) on unmount, plus the two
  // transport-reflector effects. It is the one engine now (GH117): its blueprint
  // steps the scenario cast the embedded map draws, so there is no separate world
  // controller to build or tear down alongside it.
  const { controllerRef } = usePipelineController({
    view: "pipeline",
    createController: createPipelineController,
  });

  // The dev-only local-IDE (algorithms hot-reload) client, extracted to its own hook
  // (GH109-PLAN.md): the `import.meta.env.DEV` + live-HMR-channel gate, the
  // `algoReady`/`localMode` state, and the enter/stop handlers. The one-engine model
  // (ADR 0010) makes it slugless: the override is the fixed `src/algorithms/engine.ts`.
  const dev = useLocalIde({ controllerRef });

  return (
    // ModalHost owns `.app` / `.app-shell` and the shell-inert invariant
    // (GH105-PLAN.md). `modalOpen` covers both overlays, so the shell goes inert
    // while EITHER the intro or the trace dialog is open, and a screen reader's
    // browse mode and the keyboard cannot reach shell content behind either one. The
    // shake class lands on the shell class it manages, not the outer `.app` wrapper,
    // so its transform never turns into a containing block for an overlay's
    // `position: fixed` backdrop (F006). `shellExtraClass` ANDs `shaking` with
    // `status === "running"`, so an in-flight shake clears immediately if the run
    // concludes mid-animation, instead of running out its own timer over a frozen
    // frame (CodeRabbit review). Both overlays are ModalHost's `overlays` siblings:
    // `IntroOverlay` when `introOpen`, and `TraceOverlay` unconditionally (it renders
    // null itself when neither selection is set).
    <ModalHost
      modalOpen={intro.introOpen || traceOpen}
      shellExtraClass={shaking && status === "running" ? "shake" : undefined}
      overlays={
        <>
          {intro.introOverlay}
          <TraceOverlay
            fallbackFocusRef={findingsPanelRef}
            decisionsFallbackFocusRef={decisionsPanelRef}
          />
        </>
      }
    >
      <Topbar
        mapShown={mapShown}
        onToggleMap={() => setMapShown(!mapShown)}
        reopenRef={intro.reopenRef}
        onReopen={intro.onReopen}
      />
      <Hud />
      {mapShown ? <MetroView /> : null}
      <InspectorShell findingsPanelRef={findingsPanelRef} />
      <DecisionsPanel panelRef={decisionsPanelRef} />
      <Briefing tagline={liveScenario.tagline} text={defaultEntry.catalogue.security.briefing} />
      <AlgorithmEditor onRun={() => controllerRef.current?.run()} />
      <ChaosLadder levels={chaosLevels} liveScenario={liveScenario} />
      <LocalIdeToggle
        ready={dev.algoReady}
        localMode={dev.localMode}
        onEnter={dev.onEnterLocalMode}
        onStop={dev.onStopLocalMode}
      />
    </ModalHost>
  );
}
