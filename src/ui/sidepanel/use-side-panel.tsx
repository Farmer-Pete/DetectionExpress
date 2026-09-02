/**
 * The side panel's controller: the chaos ladder and Algorithm editor tabs, moved
 * off the main column and behind a right-edge overlay (GH118-PLAN.md). It owns
 * `open` and `tab`, the two intake actions `openChaos`/`openAlgorithm`, the
 * dismiss action `close`, and the panel-owned Apply protocol `onApply`. It returns the ready-to-mount
 * `sidePanel` node, mirroring `useIntroOverlay`'s shape: `SidePanel` is only ever
 * mounted while `open` is true, so `SidePanel`'s own mount/unmount lifecycle IS the
 * panel's open/close lifecycle.
 *
 * Pause ownership runs through the store's `transport.frozen`, not a direct controller
 * call — the reflection effect in `use-pipeline-controller.ts` mirrors it onto
 * `controller.setFrozen`. Opening saves the current freeze (read fresh via
 * `getState()`, so this never depends on a stale render), then sets it true. A
 * dismiss-close (`close()`, wired to Esc, the backdrop, and the X button) restores the
 * saved value. An Apply-success-close sets it false instead, since Apply means "run
 * it." `holdsFreezeRef` tracks whether THIS open lifecycle still owns an unrestored
 * freeze, so an unmount while open (including React Strict Mode's phantom
 * cleanup+re-setup) can release it exactly once and never leak it into the store.
 *
 * Apply on success only (decision 5): `onApply` marks a pending-close intent, then
 * calls `controllerRef.current.run()` — a no-op if the controller is null. `run()`
 * flips the store's `runPending` true before its first await
 * (`run-controller.ts:400`), then resolves it false once the dry-run settles, so this
 * hook watches for the real `false -> true -> false` cycle: `sawPendingRef` records
 * that the pending phase was actually observed, so a stale intent from a PRIOR Apply
 * (already resolved before this one starts) can never fire early on this one's
 * `runPending: false` starting point. On the falling edge, `error === null` closes and
 * unfreezes; a set error leaves the panel open, showing the error line
 * `AlgorithmEditor` already renders, and clears the intent either way.
 *
 * Overlay exclusivity (GH118-PLAN.md, extended by GH124-PLAN.md Checkpoints 4-5):
 * `openChaos`/`openAlgorithm` no-op while ANY other modal is open — the
 * trace overlay (`selection`/`decisionSelection`) or the map/event dialog stack
 * (`mapDialogStack`, non-empty) — so the shell never stacks two dim backdrops.
 * `App.tsx` returns the guard: its own map/event openers no-op while `sidePanel.open`
 * is true, the same way this hook no-ops against the store's fields, so the three-way
 * exclusivity (trace, the map/event stack, side panel) holds from every direction.
 * The intro transition is App's concern: App records the tab an intro action
 * requested, closes the intro, then calls `openChaos`/`openAlgorithm` itself once the
 * intro has actually closed.
 *
 * Focus fallback for that intro path (GH118-PLAN.md): the intro button that
 * triggered the open is unmounted by the time the panel closes, so `SidePanel`'s own
 * focus-restore effect falls back to `fallbackFocusRef`. `chaosFocusRef`/
 * `algorithmFocusRef` are App's two Topbar button refs; this hook
 * forwards whichever one matches the active tab, mirroring the fallback-focus refs
 * `TraceOverlay` already takes.
 */
import { type ReactNode, type RefObject, useCallback, useEffect, useRef, useState } from "react";
import type { RunController } from "../../game/run-controller";
import { useGameStore } from "../../game/store";
import { SidePanel, type SidePanelTab } from "./SidePanel";

export type { SidePanelTab } from "./SidePanel";

export interface UseSidePanelArgs {
  controllerRef: RefObject<RunController | null>;
  /** Focus-restore fallback for the chaos tab, for when the trigger element is gone
   *  on unmount (the intro's "Cause chaos" path). Typically the Topbar chaos-ladder
   *  button's ref. */
  chaosFocusRef?: RefObject<HTMLElement | null> | undefined;
  /** Focus-restore fallback for the algorithm tab, for when the trigger element is
   *  gone on unmount (the intro's "Edit the Engine" path). Typically the Topbar
   *  Algorithm button's ref. */
  algorithmFocusRef?: RefObject<HTMLElement | null> | undefined;
}

export interface SidePanelController {
  /** True while the panel should render. */
  open: boolean;
  /** The active tab. */
  tab: SidePanelTab;
  /** Open on the chaos tab. No-op while the trace dialog or the map/event dialog
   *  stack is open. */
  openChaos: () => void;
  /** Open on the algorithm tab. No-op while the trace dialog or the map/event dialog
   *  stack is open. */
  openAlgorithm: () => void;
  /** Dismiss (Esc, backdrop, or the X button): restores the freeze saved on open. */
  close: () => void;
  /** The Algorithm tab's Apply: runs the source, closes only on success. */
  onApply: () => void;
  /** The panel element, ready to drop into ModalHost's `overlays` slot, or null. */
  sidePanel: ReactNode;
}

export function useSidePanel({
  controllerRef,
  chaosFocusRef,
  algorithmFocusRef,
}: UseSidePanelArgs): SidePanelController {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<SidePanelTab>("chaos");

  const selection = useGameStore((state) => state.selection);
  const decisionSelection = useGameStore((state) => state.decisionSelection);
  const mapDialogStack = useGameStore((state) => state.mapDialogStack);
  const setFrozen = useGameStore((state) => state.setFrozen);
  const runPending = useGameStore((state) => state.runPending);
  const error = useGameStore((state) => state.error);

  // The freeze value to restore on a dismiss-close, captured the instant this open
  // lifecycle freezes the run. `holdsFreezeRef` is true only while THIS lifecycle
  // still owns an un-restored freeze, so close(), the Apply-success edge, and the
  // unmount safety net below can never double-restore, or restore a freeze they never
  // set.
  const savedFrozenRef = useRef(false);
  const holdsFreezeRef = useRef(false);

  const openWith = useCallback(
    (nextTab: SidePanelTab): void => {
      if (selection !== null || decisionSelection !== null || mapDialogStack.length > 0) {
        return; // exclusive with the trace dialog and the map/event stack: never stack two dim backdrops
      }
      if (!holdsFreezeRef.current) {
        savedFrozenRef.current = useGameStore.getState().transport.frozen;
        setFrozen(true);
        holdsFreezeRef.current = true;
      }
      setTab(nextTab);
      setOpen(true);
    },
    [selection, decisionSelection, mapDialogStack, setFrozen],
  );

  const openChaos = useCallback(() => openWith("chaos"), [openWith]);
  const openAlgorithm = useCallback(() => openWith("algorithm"), [openWith]);

  // The panel-owned Apply intent (decision 5): `onApply` sets it, the falling-edge
  // effect below clears it (on success or failure), and `close()` clears it too, so a
  // dismiss mid-Apply can't have a late-arriving edge act on a stale intent.
  const pendingApplyRef = useRef(false);
  // True once this intent has observed `runPending` true, so the effect only ever
  // acts on the FALLING edge of a real cycle: never a leftover `false` render from
  // before this intent was set.
  const sawPendingRef = useRef(false);

  const close = useCallback((): void => {
    if (holdsFreezeRef.current) {
      setFrozen(savedFrozenRef.current);
      holdsFreezeRef.current = false;
    }
    pendingApplyRef.current = false;
    sawPendingRef.current = false;
    setOpen(false);
  }, [setFrozen]);

  const onApply = useCallback((): void => {
    const controller = controllerRef.current;
    if (controller === null) {
      return;
    }
    pendingApplyRef.current = true;
    sawPendingRef.current = false;
    controller.run();
  }, [controllerRef]);

  useEffect(() => {
    if (!pendingApplyRef.current) {
      return;
    }
    if (runPending) {
      sawPendingRef.current = true;
      return;
    }
    if (!sawPendingRef.current) {
      return; // the pending phase has not started yet: not a real edge
    }
    pendingApplyRef.current = false;
    sawPendingRef.current = false;
    if (error === null) {
      if (holdsFreezeRef.current) {
        setFrozen(false); // Apply means "run it": stay unfrozen, not restored
        holdsFreezeRef.current = false;
      }
      setOpen(false);
    }
    // A set error keeps the panel open; AlgorithmEditor already shows it from the
    // store, so there is nothing further to do here.
  }, [runPending, error, setFrozen]);

  // Unmount safety net (mirrors TraceOverlay's, `findings/TraceOverlay.tsx`): release
  // an un-restored freeze on unmount, so an App unmount (or React Strict Mode's
  // mount -> cleanup -> re-mount) while the panel is open never leaks the freeze into
  // the store forever.
  useEffect(() => {
    return () => {
      if (holdsFreezeRef.current) {
        setFrozen(savedFrozenRef.current);
        holdsFreezeRef.current = false;
      }
    };
  }, [setFrozen]);

  const fallbackFocusRef = tab === "chaos" ? chaosFocusRef : algorithmFocusRef;

  const sidePanel = open ? (
    <SidePanel
      tab={tab}
      onSelectTab={setTab}
      onClose={close}
      onApply={onApply}
      fallbackFocusRef={fallbackFocusRef}
    />
  ) : null;

  return { open, tab, openChaos, openAlgorithm, close, onApply, sidePanel };
}
