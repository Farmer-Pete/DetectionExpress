/**
 * The app shell: thin wiring over four extracted concerns (GH109-PLAN.md,
 * GH118-PLAN.md). It holds only the `mapShown` toggle, the wave shake, the
 * modal-open derivation, the two panel refs shared with
 * `InspectorShell`/`DecisionsPanel`/`TraceOverlay`, and the three Topbar button refs
 * shared with the side panel; everything else is composed from a hook or a
 * component that owns its own lifecycle and its own tests:
 *
 * - `useIntroOverlay` (intro/) owns the overlay's seen-flag state, its three dismiss
 *   actions, and the post-close focus-return effect. Its "Cause chaos"/"Edit the
 *   Engine" actions report the side-panel tab they want through the
 *   `onRequestPanel` callback this file injects (see "The intro transition" below).
 * - `usePipelineController` (run/) builds the one merged-engine `RunController` on
 *   mount and disposes it (permanently) on unmount. React Strict Mode's
 *   mount/unmount/mount cycle is safe: the factory yields a new controller per epoch
 *   and the cleanup disposes the old one. Render never drives the loop. Tests inject
 *   a controller factory through `createPipelineController`, so the app never loads
 *   the real loader or engine under test. The Apply button (now inside the side
 *   panel) reloads the current Algorithm source. GH117 unified the metro map onto
 *   this same engine, so there is only one controller and one loop now — the
 *   standalone `useWorldController` and `WorldRunController` are retired.
 * - `useSidePanel` (sidepanel/) owns the chaos-ladder/Algorithm side panel: its
 *   `open`/`tab` state, the pause protocol (see "Pause ownership" below), and the
 *   Apply-on-success-only wiring. `Topbar`'s two openers and the intro's two actions
 *   all route through it.
 * - `Topbar` renders the header: the title, the slice tag, the map show/hide toggle,
 *   the two side-panel openers, the "How this works" reopen button (wired to
 *   `useIntroOverlay`'s `reopenRef` and `onReopen`), and Hire Me.
 *
 * The four HUD gauges moved into the side panel's Metrics tab (GH124-PLAN.md
 * Checkpoint 2), so this file no longer mounts `Hud` in the main column; only the
 * run-status pill (`StatusPill`, read by `Topbar`) stays in the top bar. The pending
 * side-panel-tab dispatch below (see "The intro transition") now switches over all
 * three tabs instead of treating "not chaos" as "algorithm".
 *
 * `App` owns `.app` / `.app-shell` only indirectly: `ModalHost` (GH105-PLAN.md) is the
 * component that actually renders them and holds the shell-inert invariant. `App`
 * derives `modalOpen` — `introOpen || traceOpen || sidePanel.open` — and hands it in
 * along with all three overlays, `IntroOverlay`, `TraceOverlay`, and the side panel,
 * as `ModalHost`'s `overlays` prop. All three render as siblings of the inert shell,
 * so a screen reader's browse mode and the keyboard cannot reach shell content
 * behind any of them. `openChaos`/`openAlgorithm` are mutually exclusive with the
 * trace overlay (`useSidePanel`'s own concern), so the shell never stacks two dim
 * backdrops.
 *
 * `App` also publishes `modalOpen` to the store as `overlayOpen`, with
 * `useLayoutEffect` (not a passive effect) so it lands in the same commit as
 * `ModalHost`'s `inert` change: `LogPanel`'s global Space-to-freeze listener has no
 * idea the shell is inert, so without this it could resume a run the player can't
 * see or reach. A second effect resets `overlayOpen` to false on unmount, so an
 * unmount while an overlay is open can never leave it stuck true.
 *
 * ## The intro transition (GH118-PLAN.md)
 * The intro's "Cause chaos" and "Edit the Engine" must open the side panel, but
 * `setIntroOpen(false)` is asynchronous, so the intro still reads open at the
 * moment either fires — calling `sidePanel.openChaos()`/`openAlgorithm()` right then
 * would trip the exclusivity check the trace overlay guards against (and there is no
 * trace overlay open here; the check that matters is simply "don't open two modals
 * at once"). So the protocol is: the action (via `onRequestPanel`, injected into
 * `useIntroOverlay` below) records the requested tab in `pendingPanelTabRef` and
 * closes the intro; a plain `useEffect` here opens the panel once `intro.introOpen`
 * has actually gone false. This never fires the panel while the intro still renders,
 * since the intro is gone by the time the effect runs.
 *
 * The intro button that triggered this is unmounted before the panel could restore
 * focus to it, so the panel falls back to a stable Topbar button instead:
 * `chaosButtonRef`/`algorithmButtonRef`/`metricsButtonRef` are handed to both
 * `Topbar` (which attaches them to its three openers) and `useSidePanel` (which
 * forwards whichever one matches the active tab as `SidePanel`'s
 * `fallbackFocusRef`), the same fallback-focus pattern `TraceOverlay` already uses.
 * The intro itself only ever requests "chaos" or "algorithm" (it has no Metrics
 * action), but the pending-tab switch below still covers "metrics" so the dispatch
 * stays correct if that ever changes, rather than silently falling through to
 * Algorithm.
 *
 * ## Pause ownership (GH118-PLAN.md)
 * The pause runs through the store's `transport.frozen`, not a direct controller
 * call — the reflection effect in `use-pipeline-controller.ts` mirrors it onto
 * `controller.setFrozen`. `useSidePanel` owns the save/restore/unfreeze protocol
 * around opening and closing the panel; this file only feeds it `controllerRef`.
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
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RunController } from "../game/run-controller";
import type { MapSelection } from "../game/store";
import { useGameStore } from "../game/store";
import { DecisionsPanel } from "./decisions/DecisionsPanel";
import { InspectorShell } from "./findings/InspectorShell";
import { TraceOverlay } from "./findings/TraceOverlay";
import { useIntroOverlay } from "./intro/use-intro-overlay";
import { EventDialog } from "./log/EventDialog";
import { MetroView } from "./MetroView";
import { ModalHost } from "./ModalHost";
import { PlaceDialog } from "./metro/PlaceDialog";
import { usePipelineController } from "./run/use-pipeline-controller";
import { type SidePanelTab, useSidePanel } from "./sidepanel/use-side-panel";
import { Topbar } from "./Topbar";
import { useOneShotFlag } from "./wave/use-one-shot-flag";
import { useWavePhaseEdge } from "./wave/use-wave-phase-edge";

/** Matches the CSS `shake` keyframes' 0.3s duration (`src/index.css`). */
const SHAKE_MS = 300;

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
  // Shared with MetroView (which attaches it to the map region) and PlaceDialog
  // (which reads it as its focus-restore fallback, GH124-PLAN.md Checkpoint 4 — the
  // same fallback-focus pattern as findingsPanelRef/decisionsPanelRef above).
  const metroMapRegionRef = useRef<HTMLDivElement>(null);
  // Shared with InspectorShell (which forwards it to LogPanel) and EventDialog (which
  // reads it as its focus-restore fallback, GH124-PLAN.md Checkpoint 5 — the same
  // fallback-focus pattern as the refs above).
  const logPanelRef = useRef<HTMLDivElement>(null);
  // Shared with Topbar (which attaches them to its three openers) and useSidePanel
  // (which forwards them as the panel's intro-path focus fallback, see the module
  // doc's "The intro transition").
  const chaosButtonRef = useRef<HTMLButtonElement>(null);
  const algorithmButtonRef = useRef<HTMLButtonElement>(null);
  const metricsButtonRef = useRef<HTMLButtonElement>(null);

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
  // Feeds ModalHost's modalOpen alongside introOpen and the side panel's open state,
  // so the shell goes inert whenever any of the three is showing. This derivation is
  // sound only because the store now validates a selection against the live snapshot
  // before storing it (store.ts), so a set selection always implies TraceOverlay
  // actually renders a dialog.
  const selection = useGameStore((s) => s.selection);
  const decisionSelection = useGameStore((s) => s.decisionSelection);
  const traceOpen = selection !== null || decisionSelection !== null;

  // The place dialog (GH124-PLAN.md Checkpoint 4): `mapSelection !== null` IS "the
  // dialog is open", mirroring `traceOpen` above. Unlike the trace dialog, opening it
  // never freezes the engine (PlaceDialog's own concern, not App's) — it only feeds
  // `modalOpen` below, so the shell still goes inert while it is up.
  const mapSelection = useGameStore((s) => s.mapSelection);
  const placeOpen = mapSelection !== null;
  const selectMapNode = useGameStore((s) => s.selectMapNode);
  const selectMapTrain = useGameStore((s) => s.selectMapTrain);

  // The event dialog (GH124-PLAN.md Checkpoint 5): `eventSelection !== null` IS "the
  // dialog is open", mirroring `placeOpen` above. The store already keeps
  // `mapSelection`/`eventSelection` mutually exclusive (selecting one clears the
  // other) and reconciles `eventSelection` against the live ring on every publish, so
  // this derivation needs no further validation here.
  const eventSelection = useGameStore((s) => s.eventSelection);
  const eventOpen = eventSelection !== null;
  const selectWorldEvent = useGameStore((s) => s.selectWorldEvent);

  // The intro transition (GH118-PLAN.md, see the module doc): a dismiss that
  // requests a side-panel tab records it here instead of opening the panel
  // directly, since the intro is still (asynchronously) open at call time. Stable
  // identity, so useIntroOverlay's onCauseChaos/onEditEngine never churn.
  const pendingPanelTabRef = useRef<SidePanelTab | null>(null);
  const onRequestPanel = useCallback((tab: SidePanelTab) => {
    pendingPanelTabRef.current = tab;
  }, []);

  // The intro overlay, extracted to its own hook (GH109-PLAN.md): the seen-flag lazy
  // init, the three dismiss actions, the post-close focus-return effect, and the
  // reopen control's ref/handler.
  const intro = useIntroOverlay({ onRequestPanel });

  // The pipeline controller lifecycle, extracted to its own hook (GH109-PLAN.md): a
  // fresh controller per epoch, seeded from the store transport, disposed (with the
  // F024 empty-snapshot repaint and cleared selection) on unmount, plus the two
  // transport-reflector effects. It is the one engine now (GH117): its blueprint
  // steps the scenario cast the embedded map draws, so there is no separate world
  // controller to build or tear down alongside it.
  const { controllerRef } = usePipelineController({
    createController: createPipelineController,
  });

  // The side panel (GH118-PLAN.md, sidepanel/): the chaos ladder and Algorithm
  // editor tabs, moved off the main column behind a right-edge overlay. Owns its own
  // open/tab state, the pause protocol, and the Apply-on-success wiring.
  const sidePanel = useSidePanel({
    controllerRef,
    chaosFocusRef: chaosButtonRef,
    algorithmFocusRef: algorithmButtonRef,
    metricsFocusRef: metricsButtonRef,
  });

  // No-op while another overlay is already open (mirrors useSidePanel's own openWith
  // exclusivity check): the shell being inert already blocks a real pointer/keyboard
  // click from reaching the map, but this guard is what actually enforces "only one
  // map modal at a time" against any path that is not gated by inert. `onEventSelect`
  // below applies the identical guard to the event opener, so the two stay
  // consistent (a Codex review caught the event opener going unguarded here).
  const onMapSelect = useCallback(
    (next: MapSelection) => {
      if (intro.introOpen || traceOpen || sidePanel.open || eventOpen) {
        return;
      }
      if (next.kind === "node") {
        selectMapNode(next.id);
      } else {
        selectMapTrain(next.actorId);
      }
    },
    [intro.introOpen, traceOpen, sidePanel.open, eventOpen, selectMapNode, selectMapTrain],
  );

  // The event opener's guard, mirroring `onMapSelect` above: the shell's `inert` gate
  // already blocks a real click on a log row while another overlay is open, but this
  // is what enforces "only one event modal at a time" against any path not gated by
  // inert. Forwarded to `LogPanel` (via `InspectorShell`'s `onSelectEvent` prop) so a
  // row click routes through this guard instead of calling the store directly.
  const onEventSelect = useCallback(
    (id: number) => {
      if (intro.introOpen || traceOpen || sidePanel.open || placeOpen) {
        return;
      }
      selectWorldEvent(id);
    },
    [intro.introOpen, traceOpen, sidePanel.open, placeOpen, selectWorldEvent],
  );

  // Complete the intro transition: once the intro has actually closed, act on
  // whatever tab a dismiss recorded (see the module doc's "The intro transition").
  // A no-op on every other render, since `pendingPanelTabRef` only ever holds a
  // value between an intro dismiss and this effect's next run. A switch over all
  // three tabs, not an if/else that treats "not chaos" as "algorithm" — the bug
  // that shipped before GH124-PLAN.md Checkpoint 2 added the metrics tab.
  useEffect(() => {
    if (intro.introOpen) {
      return;
    }
    const tab = pendingPanelTabRef.current;
    if (tab === null) {
      return;
    }
    pendingPanelTabRef.current = null;
    switch (tab) {
      case "chaos":
        sidePanel.openChaos();
        break;
      case "algorithm":
        sidePanel.openAlgorithm();
        break;
      case "metrics":
        sidePanel.openMetrics();
        break;
    }
  }, [intro.introOpen, sidePanel.openChaos, sidePanel.openAlgorithm, sidePanel.openMetrics]);

  const modalOpen = intro.introOpen || traceOpen || sidePanel.open || placeOpen || eventOpen;

  // Publish `modalOpen` to the store as `overlayOpen`, in the same commit
  // ModalHost's `inert` change lands in (`useLayoutEffect`, not a passive effect):
  // LogPanel's Space-to-freeze listener has no idea the shell is inert, so this is
  // what keeps Space from resuming a run hidden behind an overlay.
  const setOverlayOpen = useGameStore((s) => s.setOverlayOpen);
  useLayoutEffect(() => {
    setOverlayOpen(modalOpen);
  }, [modalOpen, setOverlayOpen]);
  // A separate effect, not the cleanup of the one above: its cleanup should fire
  // only on a real App unmount, not on every modalOpen change. Guards against an
  // unmount while an overlay is open leaving `overlayOpen` stuck true forever.
  useLayoutEffect(() => {
    return () => setOverlayOpen(false);
  }, [setOverlayOpen]);

  return (
    // ModalHost owns `.app` / `.app-shell` and the shell-inert invariant
    // (GH105-PLAN.md). `modalOpen` covers all three overlays, so the shell goes
    // inert while ANY of the intro, the trace dialog, or the side panel is open, and
    // a screen reader's browse mode and the keyboard cannot reach shell content
    // behind any of them. The shake class lands on the shell class it manages, not
    // the outer `.app` wrapper, so its transform never turns into a containing block
    // for an overlay's `position: fixed` backdrop (F006). `shellExtraClass` ANDs
    // `shaking` with `status === "running"`, so an in-flight shake clears
    // immediately if the run concludes mid-animation, instead of running out its own
    // timer over a frozen frame (CodeRabbit review). All three overlays are
    // ModalHost's `overlays` siblings: `IntroOverlay` when `introOpen`,
    // `TraceOverlay` unconditionally (it renders null itself when neither selection
    // is set), and the side panel when `sidePanel.open`.
    <ModalHost
      modalOpen={modalOpen}
      shellExtraClass={shaking && status === "running" ? "shake" : undefined}
      overlays={
        <>
          {intro.introOverlay}
          <TraceOverlay
            fallbackFocusRef={findingsPanelRef}
            decisionsFallbackFocusRef={decisionsPanelRef}
          />
          <PlaceDialog fallbackFocusRef={metroMapRegionRef} />
          <EventDialog fallbackFocusRef={logPanelRef} />
          {sidePanel.sidePanel}
        </>
      }
    >
      <Topbar
        mapShown={mapShown}
        onToggleMap={() => setMapShown(!mapShown)}
        reopenRef={intro.reopenRef}
        onReopen={intro.onReopen}
        onOpenChaos={sidePanel.openChaos}
        onOpenAlgorithm={sidePanel.openAlgorithm}
        onOpenMetrics={sidePanel.openMetrics}
        chaosButtonRef={chaosButtonRef}
        algorithmButtonRef={algorithmButtonRef}
        metricsButtonRef={metricsButtonRef}
      />
      {mapShown ? <MetroView onSelect={onMapSelect} mapRegionRef={metroMapRegionRef} /> : null}
      <InspectorShell
        findingsPanelRef={findingsPanelRef}
        logPanelRef={logPanelRef}
        onSelectEvent={onEventSelect}
      />
      <DecisionsPanel panelRef={decisionsPanelRef} />
    </ModalHost>
  );
}
