/**
 * The app shell: thin wiring over four extracted concerns (GH109-PLAN.md,
 * GH118-PLAN.md). It holds only the `mapShown` toggle, the wave shake, the
 * modal-open derivation, the two panel refs shared with
 * `InspectorShell`/`DecisionsPanel`/`TraceOverlay`, and the hamburger trigger
 * ref shared with the side panel (GH132-PLAN.md M1); everything else is
 * composed from a hook or a component that owns its own lifecycle and its own
 * tests:
 *
 * - `usePipelineController` (run/) builds the one merged-engine `RunController` on
 *   mount and disposes it (permanently) on unmount. React Strict Mode's
 *   mount/unmount/mount cycle is safe: the factory yields a new controller per epoch
 *   and the cleanup disposes the old one. Render never drives the loop. Tests inject
 *   a controller factory through `createPipelineController`, so the app never loads
 *   the real loader or engine under test. The Apply button (now inside the side
 *   panel) reloads the current Algorithm source. GH117 unified the metro map onto
 *   this same engine, so there is only one controller and one loop now — the
 *   standalone `useWorldController` and `WorldRunController` are retired.
 * - `useSidePanel` (sidepanel/) owns the chaos-ladder/Algorithm/Options side panel:
 *   its `open`/`tab` state, the pause protocol (see "Pause ownership" below), and the
 *   Apply-on-success-only wiring. The hamburger's own opener (`openPanel`) routes
 *   through it. `mapShown`/`onToggleMap`/`onStartTour` (GH132-PLAN.md M2, see "The
 *   start-tour transition" below) feed its Options tab.
 * - `useTour` (tour/) owns the one driver.js instance behind an injected factory
 *   (`createTourDriver`, `tour/driver-factory.ts`; `App`'s own `createTourDriver` prop
 *   overrides it for tests, mirroring `createPipelineController`). It auto-starts once
 *   on first load whenever `hasSeenTour()` reads false (GH132-PLAN.md M3; the hook's
 *   own module doc covers the StrictMode-safe deferred-task/session-guard mechanics).
 *   `startTour` is also user-triggered, from the Options tab's "Retake tour" button,
 *   which always starts regardless of the seen flag or the session guard. The tour is
 *   NOT a modal (docs/adr/0012), so it never feeds `modalOpen` below.
 * - `Topbar` renders the header: the title, the slice tag, the hamburger button
 *   (GH132-PLAN.md M1, design revision — a plain icon button that opens the side
 *   panel directly, no popup), and Hire Me. The map toggle lives in the side panel's
 *   own Options tab instead of a standalone Topbar button.
 *
 * The sim keeps computing throughput/queue/compute/correctness (`SimSnapshot`), but
 * nothing currently displays them; the top bar's own run-status pill (`StatusPill`,
 * the "RUNNING" badge) is gone too (GH132-PLAN.md M2).
 *
 * `App` owns `.app` / `.app-shell` only indirectly: `ModalHost` (GH105-PLAN.md) is the
 * component that actually renders them and holds the shell-inert invariant. `App`
 * derives `modalOpen` — `traceOpen || sidePanel.open || stackOpen || legendOpen`
 * (GH133-PLAN.md added the last term) — and hands it in along with all five overlays,
 * `TraceOverlay`, `PlaceDialog` (GH124-PLAN.md Checkpoint 4), `EventDialog`
 * (Checkpoint 5), the side panel, and `LegendDialog` (GH133-PLAN.md), as `ModalHost`'s
 * `overlays` prop. `PlaceDialog` and `EventDialog` are both always mounted, but
 * share one bounded stack (`mapDialogStack`, store.ts) and each self-selects
 * rendering off its TOP entry, so only one of the two is ever actually on screen —
 * pushing a second dialog from within the first (its "Open place" link, or a
 * scoped-log row) swaps which of the two renders without emptying the stack, so a
 * "‹ Back" control in the newly-topmost dialog can pop back to the one underneath.
 * All five overlays render as siblings of the inert shell, so a screen reader's
 * browse mode and the keyboard cannot reach shell content behind any of them.
 * `sidePanel.openChaos`/`openAlgorithm` are mutually exclusive with the trace
 * overlay (`useSidePanel`'s own concern), and `onMapSelect`/`onEventSelect` below
 * enforce the same exclusivity against the whole map/event stack, so the shell
 * never stacks a second dim backdrop behind it.
 *
 * ## The mobile legend dialog (GH133-PLAN.md)
 * `MetroView`'s floating chip (mobile-only via CSS) calls `openLegend`, which no-ops
 * while `traceOpen`, `sidePanel.open`, or `stackOpen` is already true — the same
 * exclusivity guard the other openers apply, so the shell never stacks two dim
 * backdrops. `onMapSelect`, `onEventSelect`, and the hamburger's own opener
 * (`onOpenMenu` below) each also reject while `legendOpen` is true, closing the loop
 * from every direction. `legendOpen` feeds `modalOpen` above, so the shell goes inert
 * behind `LegendDialog` exactly like the other overlays. `LegendDialog` is
 * deliberately NOT `MapDialogShell`: that shell's close/focus are bound to
 * `mapDialogStack`, and clearing an empty map stack on Escape/backdrop would leave
 * `legendOpen` stuck true (see `LegendDialog.tsx`'s own module doc). A resize effect
 * closes the legend if the viewport crosses to >=720px while it is open, so the
 * hidden mobile chip never strands a dialog no keyboard/pointer path can reach.
 *
 * `App` also publishes `modalOpen` to the store as `overlayOpen`, with
 * `useLayoutEffect` (not a passive effect) so it lands in the same commit as
 * `ModalHost`'s `inert` change: `LogPanel`'s global Space-to-freeze listener has no
 * idea the shell is inert, so without this it could resume a run the player can't
 * see or reach. A second effect resets `overlayOpen` to false on unmount, so an
 * unmount while an overlay is open can never leave it stuck true.
 *
 * ## The start-tour transition (GH132-PLAN.md M2)
 * The side panel's Options tab carries a "Retake tour" button that starts the guided
 * tour. The panel is a modal (the shell goes `inert` behind it) and the tour's targets
 * — including the hamburger itself — sit inside that shell, so `onStartTour` cannot
 * start the tour while the panel is still open: the shell must be interactive again
 * first. It records the request (`pendingStartTourRef`) and closes the panel first; a
 * plain `useEffect` here starts the tour once `sidePanel.open` has actually gone
 * false. `closeSidePanelRef` exists only to break the circularity of handing
 * `onStartTour` INTO `useSidePanel` while it needs `useSidePanel`'s own `close`
 * function: the ref is written every render (not in an effect, so it is never one
 * render stale) and `onStartTour` reads it lazily, at click time, not at definition
 * time.
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
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RunController } from "../game/run-controller";
import type { MapSelection } from "../game/store";
import { topMapDialogEntry, useGameStore } from "../game/store";
import type { ConfettiOrigin } from "./confetti";
import { DecisionsPanel } from "./decisions/DecisionsPanel";
import { InspectorShell } from "./findings/InspectorShell";
import { TraceOverlay } from "./findings/TraceOverlay";
import { EventDialog } from "./log/EventDialog";
import { MetroView } from "./MetroView";
import { ModalHost } from "./ModalHost";
import { LegendDialog } from "./metro/LegendDialog";
import { PlaceDialog } from "./metro/PlaceDialog";
import { usePipelineController } from "./run/use-pipeline-controller";
import { readShortcutsEnabled, writeShortcutsEnabled } from "./shortcuts/shortcuts-preference";
import type { ShortcutsAppState } from "./shortcuts/use-shortcuts";
import { ShortcutsProvider } from "./shortcuts/use-shortcuts";
import { useSidePanel } from "./sidepanel/use-side-panel";
import { Topbar } from "./Topbar";
import type { TourDriverFactory } from "./tour/driver-factory";
import { useTour } from "./tour/use-tour";
import { useOneShotFlag } from "./wave/use-one-shot-flag";
import { useWavePhaseEdge } from "./wave/use-wave-phase-edge";

/** Matches the CSS `shake` keyframes' 0.3s duration (`src/index.css`). */
const SHAKE_MS = 300;

interface AppProps {
  // The controller FACTORY: builds a FRESH controller on mount and disposes it on
  // unmount (disposal is permanent). Tests inject a stub factory.
  createPipelineController?: () => RunController;
  // The tour's driver.js factory (GH132-PLAN.md M2), forwarded to `useTour`. Tests
  // inject a fake, mirroring `createPipelineController` above; defaults to the real
  // driver.js wrapper (`useTour`'s own default) when omitted.
  createTourDriver?: TourDriverFactory;
  // The Hire Me confetti seam (GH137-PLAN.md M2), forwarded to `Topbar` -> `<HireMe>`.
  // Mirrors `createPipelineController`/`createTourDriver` above: tests inject a spy so
  // exercising the real "H" shortcut/click never runs canvas-confetti against
  // happy-dom's DOM (which carries no real 2D canvas context); defaults to the real
  // burst (`HireMe`'s own default) when omitted.
  celebrateHireMe?: ((origin: ConfettiOrigin) => void) | undefined;
}

export function App({
  createPipelineController,
  createTourDriver,
  celebrateHireMe,
}: AppProps = {}) {
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
  // Shared with BOTH PlaceDialog and EventDialog (GH124 follow-up, the dialog
  // navigation stack): the element that triggered the current map/event dialog-stack
  // session's very first, "outside", open — captured and consumed by
  // `useMapDialogFocus` (`dialog-stack-focus.ts`), not by either dialog component on
  // its own, since only ONE shared ref can survive a push swapping which of the two
  // dialogs is actually mounted.
  const mapDialogRootTriggerRef = useRef<Element | null>(null);
  // Paired with the ref above (same capture instant, same lifetime): the ROOT
  // session's own fallback-focus ref (`metroMapRegionRef` for a map-rooted session,
  // `logPanelRef` for an event-rooted one), so a full close restores to the fallback
  // of whichever dialog opened the session rather than whichever one is on top when
  // it closes — see `dialog-stack-focus.ts`.
  const mapDialogRootFallbackRef = useRef<RefObject<HTMLElement | null> | null>(null);
  // Shared with Topbar (which attaches it to the hamburger button, GH132-PLAN.md
  // M1) and useSidePanel (which forwards it as the chaos, algorithm, AND options
  // tab's focus fallback, since one trigger opens all three — the same
  // fallback-focus pattern `TraceOverlay` already uses).
  const hamburgerTriggerRef = useRef<HTMLButtonElement>(null);
  // Shared with MetroView (which attaches it to the mobile legend chip) and
  // LegendDialog (which restores focus here on close, GH133-PLAN.md — the same
  // fallback-focus pattern as the refs above, except LegendDialog always restores
  // here rather than falling back to it, per the module doc's "explicit ref" note).
  const legendTriggerRef = useRef<HTMLButtonElement>(null);

  // The mobile legend dialog (GH133-PLAN.md): opened from MetroView's floating chip,
  // closed from LegendDialog itself, and force-closed by the resize effect below.
  const [legendOpen, setLegendOpen] = useState(false);

  // The Hire Me card's open state (GH137-PLAN.md M2): lifted here from HireMe's own
  // private useState, so resolveActiveScope (shortcutsAppState below) can see it and
  // give it its own "hireMe" scope, instead of shell shortcuts staying live underneath
  // its scrim. HireMe still owns the Escape/outside-click listeners and the confetti
  // call; it only reports the resulting open/close through this callback now.
  const [hireMeOpen, setHireMeOpen] = useState(false);

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
  // Feeds ModalHost's modalOpen alongside the side panel's open state and the map/
  // event dialog stack, so the shell goes inert whenever any of the three is
  // showing. This derivation is sound only because the store now validates a
  // selection against the live snapshot before storing it (store.ts), so a set
  // selection always implies TraceOverlay actually renders a dialog.
  const selection = useGameStore((s) => s.selection);
  const decisionSelection = useGameStore((s) => s.decisionSelection);
  const traceOpen = selection !== null || decisionSelection !== null;

  // The place/event dialog stack (GH124-PLAN.md Checkpoints 4-5, restructured for
  // Back navigation): `mapDialogStack.length > 0` IS "a place or event dialog is
  // open", mirroring `traceOpen` above — one flag covers both dialogs now, since a
  // push (from inside either one) leaves the stack non-empty exactly like a fresh
  // "outside" open does. Unlike the trace dialog, opening it never freezes the engine
  // (PlaceDialog's/EventDialog's own concern, not App's) — it only feeds `modalOpen`
  // below, so the shell still goes inert while it is up. `PlaceDialog`/`EventDialog`
  // each self-select which one renders off the stack's top entry, so App only needs
  // the three "outside" openers (a map click, a main-log-row click) and the
  // stack-non-empty flag; the "inside" pushers (`openPlaceFromEvent`,
  // `openEventFromPlace`) live entirely inside the two dialogs.
  const mapDialogStack = useGameStore((s) => s.mapDialogStack);
  const stackOpen = mapDialogStack.length > 0;
  const selectMapNode = useGameStore((s) => s.selectMapNode);
  const selectMapTrain = useGameStore((s) => s.selectMapTrain);
  const selectWorldEvent = useGameStore((s) => s.selectWorldEvent);

  // The pipeline controller lifecycle, extracted to its own hook (GH109-PLAN.md): a
  // fresh controller per epoch, seeded from the store transport, disposed (with the
  // F024 empty-snapshot repaint and cleared selection) on unmount, plus the two
  // transport-reflector effects. It is the one engine now (GH117): its blueprint
  // steps the scenario cast the embedded map draws, so there is no separate world
  // controller to build or tear down alongside it.
  const { controllerRef } = usePipelineController({
    createController: createPipelineController,
  });

  // The tour (GH132-PLAN.md M2, see the module doc): `startTour` is user-triggered
  // this milestone, from the Options tab's "Retake tour" button. Focus restores to
  // the same hamburger trigger ref the side panel already falls back to.
  //
  // Drawer-open wiring ("Step 2 drawer-open"): the tour opens the side panel to
  // spotlight the chaos ladder. `useTour` is created before `useSidePanel` (whose own
  // `onStartTour` depends on the tour), so these refs bridge the cycle the same way
  // `closeSidePanelRef` does below: written every render, read lazily at click time.
  const openDrawerRef = useRef<() => void>(() => {});
  const closeDrawerRef = useRef<() => void>(() => {});
  // Whether any modal owns the shell, read lazily by the tour's auto-start (Codex
  // round 3). A ref bridges the cycle because `useTour` is created before `modalOpen`
  // exists; it is written on COMMIT by a `useLayoutEffect` below (never during render,
  // which could record an uncommitted concurrent-render value). The auto-start defers
  // (without consuming its one-shot session guard) while this reads true, so the tour
  // never drives over an open legend.
  const modalOpenRef = useRef(false);
  // The shortcuts dispatcher's bail-check-1 flag (GH137-PLAN.md): owned here, shared
  // with both `useTour` (which flips it) and `ShortcutsProvider` below (which reads it).
  const tourOwnsKeyboardRef = useRef(false);
  // The WCAG 2.1.4 off-switch (GH137-PLAN.md code review fix 4): the player's
  // persisted keyboard-shortcuts on/off preference. Read once, lazily, from
  // `shortcuts-preference.ts`'s guarded `localStorage` wrapper (mirroring
  // `useTour`'s own `hasSeenAtMount` read); every toggle writes straight through, so
  // it survives a reload. `ShortcutsProvider` reads it to bail its dispatcher/
  // registration; the Options tab's checkbox (via `useSidePanel`) reads and flips it.
  const [shortcutsEnabled, setShortcutsEnabledState] = useState(() => readShortcutsEnabled());
  const onToggleShortcuts = useCallback(() => {
    setShortcutsEnabledState((prev) => {
      const next = !prev;
      writeShortcutsEnabled(next);
      return next;
    });
  }, []);
  const tour = useTour({
    triggerRef: hamburgerTriggerRef,
    createDriver: createTourDriver,
    openDrawer: () => openDrawerRef.current(),
    closeDrawer: () => closeDrawerRef.current(),
    isModalOpen: () => modalOpenRef.current,
    tourOwnsKeyboardRef,
  });

  // The start-tour transition (GH132-PLAN.md M2, see the module doc): the Options
  // tab's "Retake tour" button closes the panel first, then this effect starts the
  // tour once the panel has actually closed. `closeSidePanelRef` breaks the
  // circularity of `onStartTour` needing `sidePanel.close` while it is itself an
  // argument to the `useSidePanel` call that produces `sidePanel` — written every
  // render, read lazily at click time.
  const closeSidePanelRef = useRef<() => void>(() => {});
  const pendingStartTourRef = useRef(false);
  const onStartTour = useCallback(() => {
    // Restore the map before the tour runs (Codex §6 fix 2): a retake after "Hide metro
    // view" must have the map anchor for steps 1, 3, and 8. Batched with the panel close,
    // so the map is committed by the time the start-tour effect fires post-close.
    setMapShown(true);
    pendingStartTourRef.current = true;
    closeSidePanelRef.current();
  }, []);

  // The side panel (GH118-PLAN.md, sidepanel/): the chaos ladder, Algorithm editor,
  // and Options tabs, moved off the main column behind a right-edge overlay. Owns
  // its own open/tab state, the pause protocol, and the Apply-on-success wiring.
  const sidePanel = useSidePanel({
    controllerRef,
    chaosFocusRef: hamburgerTriggerRef,
    algorithmFocusRef: hamburgerTriggerRef,
    optionsFocusRef: hamburgerTriggerRef,
    mapShown,
    onToggleMap: () => setMapShown(!mapShown),
    onStartTour,
    shortcutsEnabled,
    onToggleShortcuts,
  });
  closeSidePanelRef.current = sidePanel.close;
  openDrawerRef.current = () => sidePanel.openForTour("chaos");
  closeDrawerRef.current = sidePanel.closeForTour;

  useEffect(() => {
    if (sidePanel.open) {
      return;
    }
    if (!pendingStartTourRef.current) {
      return;
    }
    pendingStartTourRef.current = false;
    tour.startTour();
  }, [sidePanel.open, tour.startTour]);

  // No-op while another overlay is already open (mirrors useSidePanel's own openWith
  // exclusivity check): the shell being inert already blocks a real pointer/keyboard
  // click from reaching the map, but this guard is what actually enforces "only one
  // dialog stack at a time" against any path that is not gated by inert. Both this and
  // `onEventSelect` below guard on the SAME `stackOpen` flag now (a map click and a
  // main-log-row click are both "outside" openers, only reachable while the stack is
  // empty — see `mapDialogStack`'s doc comment in store.ts), so the two stay
  // consistent (a Codex review once caught the event opener going unguarded here).
  // `legendOpen` joins the guard (GH133-PLAN.md): the legend dialog is a fifth
  // overlay, so a map click while it is open must reject exactly like it does against
  // the other three.
  const onMapSelect = useCallback(
    (next: MapSelection) => {
      if (traceOpen || sidePanel.open || stackOpen || legendOpen) {
        return;
      }
      if (next.kind === "node") {
        selectMapNode(next.id);
      } else {
        selectMapTrain(next.actorId);
      }
    },
    [traceOpen, sidePanel.open, stackOpen, legendOpen, selectMapNode, selectMapTrain],
  );

  // The event opener's guard, mirroring `onMapSelect` above (including the
  // `legendOpen` term, GH133-PLAN.md). Forwarded to `LogPanel` (via `InspectorShell`'s
  // `onSelectEvent` prop) so a row click routes through this guard instead of calling
  // the store directly.
  const onEventSelect = useCallback(
    (id: number) => {
      if (traceOpen || sidePanel.open || stackOpen || legendOpen) {
        return;
      }
      selectWorldEvent(id);
    },
    [traceOpen, sidePanel.open, stackOpen, legendOpen, selectWorldEvent],
  );

  // The legend chip's opener (GH133-PLAN.md): no-ops while another overlay already
  // owns the shell, mirroring `useSidePanel`'s own `openWith` guard, and also while
  // the tour is active (Codex round 3 MAJOR) — the tour is not a modal, so it leaves
  // the map-region chip interactive, and a mid-tour click on it would otherwise open
  // the legend over the running tour. The reverse direction —
  // `onMapSelect`/`onEventSelect`/the hamburger opener rejecting while `legendOpen`,
  // and the auto-start deferring while a modal is open — is enforced at each of those
  // sites instead.
  const openLegend = useCallback(() => {
    if (traceOpen || sidePanel.open || stackOpen || tour.active) {
      return;
    }
    setLegendOpen(true);
  }, [traceOpen, sidePanel.open, stackOpen, tour.active]);

  // The hamburger's own opener no-ops while the legend dialog is open (GH133-PLAN.md,
  // the reverse direction of `openLegend`'s guard above): the legend chip that opened
  // it is hidden at desktop widths, but a still-mounted mobile dialog must not let the
  // hamburger stack the side panel behind/above it.
  const onOpenMenu = useCallback(() => {
    if (legendOpen) {
      return;
    }
    sidePanel.openPanel();
  }, [legendOpen, sidePanel.openPanel]);

  // A resize to >=720px while the legend is open closes it (GH133-PLAN.md): the
  // chip that opens it is CSS-hidden at that width, so a still-open dialog there
  // would be reachable by neither the chip nor (once closed) any way back in.
  useEffect(() => {
    if (!legendOpen) {
      return;
    }
    const query = window.matchMedia("(min-width: 720px)");
    const onChange = (): void => {
      if (query.matches) {
        setLegendOpen(false);
      }
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [legendOpen]);

  const modalOpen = traceOpen || sidePanel.open || stackOpen || legendOpen;
  // Bridge `modalOpen` to the tour's auto-start guard (see `modalOpenRef` above) on
  // COMMIT, not during render (Codex round 3, round 2): a render-phase ref write can
  // record an uncommitted value from a discarded concurrent render, which the
  // auto-start timer could then read and start the tour over a still-open modal. A
  // `useLayoutEffect` lands the write in the same commit as the inert change below, so
  // the timer only ever reads committed modal state.
  useLayoutEffect(() => {
    modalOpenRef.current = modalOpen;
  }, [modalOpen]);

  // The shortcuts provider's active-scope input (GH137-PLAN.md), derived from exactly
  // the same flags `modalOpen` already reads, plus the map dialog's own KIND (mapDialog:
  // event vs. mapDialog:place are separate scopes), the side panel's active tab, and
  // (M2) the real `hireMeOpen`, now that Hire Me's `open` state is lifted here.
  const shortcutsAppState: ShortcutsAppState = {
    traceOpen,
    mapDialogKind: topMapDialogEntry(mapDialogStack)?.kind ?? null,
    legendOpen,
    sidePanelOpen: sidePanel.open,
    sidePanelTab: sidePanel.tab,
    hireMeOpen,
  };

  // Publish overlay-open to the store, in the same commit ModalHost's `inert` change
  // lands in (`useLayoutEffect`, not a passive effect): LogPanel's Space-to-freeze
  // listener has no idea the shell is inert, so this is what keeps Space from resuming a
  // run hidden behind an overlay. The guided tour is NOT a modal (it never inerts the
  // shell), but Space must stay suppressed while it runs (GH132-PLAN.md M2, Codex fix
  // 1), so `tour.active` is ORed in HERE only — ModalHost's inert below still keys on
  // `modalOpen` alone, so the shell stays interactive during the tour.
  const overlayOrTourActive = modalOpen || tour.active;
  const setOverlayOpen = useGameStore((s) => s.setOverlayOpen);
  useLayoutEffect(() => {
    setOverlayOpen(overlayOrTourActive);
  }, [overlayOrTourActive, setOverlayOpen]);
  // A separate effect, not the cleanup of the one above: its cleanup should fire
  // only on a real App unmount, not on every modalOpen change. Guards against an
  // unmount while an overlay is open leaving `overlayOpen` stuck true forever.
  useLayoutEffect(() => {
    return () => setOverlayOpen(false);
  }, [setOverlayOpen]);

  return (
    // ModalHost owns `.app` / `.app-shell` and the shell-inert invariant
    // (GH105-PLAN.md). `modalOpen` covers all five overlays, so the shell goes
    // inert while ANY of the trace dialog, the place dialog, the event dialog, the
    // side panel, or the legend dialog is open, and a screen reader's browse mode
    // and the keyboard cannot reach shell content behind any of them. The shake
    // class lands on the shell class it manages, not the outer `.app` wrapper, so
    // its transform never turns into a containing block for an overlay's
    // `position: fixed` backdrop (F006). `shellExtraClass` ANDs `shaking` with
    // `status === "running"` and `!tour.active` (GH132-PLAN.md M2, Codex fix 12: a
    // shake would drift the tour's spotlight target away from driver.js's fixed
    // overlay), so an in-flight shake clears immediately if the run concludes
    // mid-animation, instead of running out its own timer over a frozen frame
    // (CodeRabbit review). All five overlays are ModalHost's `overlays` siblings:
    // `TraceOverlay` unconditionally (it renders null itself when neither selection
    // is set), `PlaceDialog` and `EventDialog` unconditionally too (each renders null
    // unless it is the KIND named by `mapDialogStack`'s top entry), the side panel
    // when `sidePanel.open`, and `LegendDialog` when `legendOpen` (GH133-PLAN.md).
    // The `ShortcutsProvider` wraps the whole shell (GH137-PLAN.md): it hosts the one
    // keyboard-shortcut dispatcher, reading `shortcutsAppState` for the active scope
    // and `tourOwnsKeyboardRef` to stand down while the tour drives.
    <ShortcutsProvider
      appState={shortcutsAppState}
      tourOwnsKeyboardRef={tourOwnsKeyboardRef}
      shortcutsEnabled={shortcutsEnabled}
    >
      <ModalHost
        modalOpen={modalOpen}
        shellExtraClass={shaking && status === "running" && !tour.active ? "shake" : undefined}
        overlays={
          <>
            <TraceOverlay
              fallbackFocusRef={findingsPanelRef}
              decisionsFallbackFocusRef={decisionsPanelRef}
            />
            <PlaceDialog
              fallbackFocusRef={metroMapRegionRef}
              rootTriggerRef={mapDialogRootTriggerRef}
              rootFallbackFocusRef={mapDialogRootFallbackRef}
            />
            <EventDialog
              fallbackFocusRef={logPanelRef}
              rootTriggerRef={mapDialogRootTriggerRef}
              rootFallbackFocusRef={mapDialogRootFallbackRef}
            />
            {sidePanel.sidePanel}
            {legendOpen ? (
              <LegendDialog
                onClose={() => setLegendOpen(false)}
                triggerRef={legendTriggerRef}
                fallbackFocusRef={metroMapRegionRef}
              />
            ) : null}
          </>
        }
      >
        <Topbar
          onOpenMenu={onOpenMenu}
          hamburgerTriggerRef={hamburgerTriggerRef}
          hireMeOpen={hireMeOpen}
          onHireMeOpenChange={setHireMeOpen}
          celebrateHireMe={celebrateHireMe}
        />
        {mapShown ? (
          <MetroView
            onSelect={onMapSelect}
            mapRegionRef={metroMapRegionRef}
            onOpenLegend={openLegend}
            legendTriggerRef={legendTriggerRef}
          />
        ) : null}
        <InspectorShell
          findingsPanelRef={findingsPanelRef}
          logPanelRef={logPanelRef}
          onSelectEvent={onEventSelect}
        />
        <DecisionsPanel panelRef={decisionsPanelRef} />
      </ModalHost>
    </ShortcutsProvider>
  );
}
