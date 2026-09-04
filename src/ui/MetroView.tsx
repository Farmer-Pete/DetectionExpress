/**
 * The embedded metro map region (GH117 Part F): the map, the transient wave-outcome
 * banner over it (`WaveOutcomeBanner`, GH126-PLAN.md M3b), and the key (Lines,
 * Actors, Sensors) as a sibling of the map inside `.metro-view`. The banner replaces
 * the earlier "simulation ended" won/lost overlay: the endless baseline never
 * concludes (GH126-PLAN.md), so a per-wave held/breach reading is the outcome that
 * matters now, not a terminal one. It sits inline in `App`'s page flow between `Hud`
 * and `InspectorShell`, sized to a bounded box rather than filling the viewport — the
 * pipeline transport (freeze, 0.5x/1x/2x) is the one clock now, so this component
 * owns no header, no counts, and no speed control.
 *
 * The legend (Lines, Actors, Sensors), GH133-PLAN.md: `MetroKey` renders the shared
 * `LegendSections` once, as the desktop left rail — `.metro-view`'s CSS grid
 * (src/index.css) sizes it beside the map at or above 720px, and hides it outright
 * below that. Below 720px the same content instead lives behind the floating
 * `.metro-legend-button` chip rendered inside `.metro-map-region`: clicking it calls
 * `onOpenLegend` (App owns the `legendOpen` boolean and mounts `LegendDialog`, a
 * standalone modal — not this component's concern), so the rail and the dialog are
 * never both live at once (see `LegendSections.tsx`'s module doc).
 *
 * Every live value is read through a per-field `useGameStore` selector, so a snapshot
 * update re-renders only the panel that reads the changed field, not the whole view
 * (ARCHITECTURE rule 4). The map's hot path (moving actors, flashes) is the canvas
 * layer, not React.
 *
 * GH124-PLAN.md Checkpoint 4: `onSelect` and `mapRegionRef` pass straight through to
 * `MetroMap`/the map region — App owns the actual selection state (the store's
 * `mapDialogStack`) and the place dialog's focus-restore fallback, so this component
 * stays a thin relay for both, the same way it already relays nothing else of its own.
 *
 * GH137-PLAN.md M2: the "Show legend" chip carries the shell scope's `L` shortcut.
 * Code review MAJOR fix: the chip is CSS-hidden at >=720px (the module doc above), so
 * an unconditional `enabled: true` let a desktop "L" open a dialog with no visible
 * badge — a shortcut with no discovery surface, and a redundant one besides (the same
 * content already shows in the always-visible desktop rail, `MetroKey` below). The fix
 * tracks the identical breakpoint in React (`useNarrowScreen`, the same
 * `addEventListener("change", ...)` pattern `FxLayer.tsx`'s `usePrefersReducedMotion`
 * already uses, and the same query string `use-tour.ts`'s `NARROW_QUERY` reads) and
 * passes it as `enabled` to `useShortcut`, so the shortcut registers — and the badge
 * renders — only while the chip is genuinely the discoverable, on-screen surface for
 * it. `onOpenLegend` itself already no-ops while another overlay or the tour owns the
 * shell (`App.tsx`'s `openLegend`), so this needs no extra guard beyond the breakpoint.
 */

import { List } from "lucide-react";
import { type RefObject, useEffect, useState } from "react";
import type { MapSelection } from "../game/store";
import { MetroMap } from "./MetroMap";
import { LegendSections } from "./metro/LegendSections";
import { Kbd } from "./shortcuts/Kbd";
import { ariaKeyshortcut } from "./shortcuts/shortcuts.data";
import { useShortcut } from "./shortcuts/use-shortcut";
import { WaveOutcomeBanner } from "./wave/WaveOutcomeBanner";

/** The mobile breakpoint: the identical string `src/index.css` uses for
 *  `.metro-legend-button`'s own CSS-hide rule, and `tour/use-tour.ts`'s own
 *  `NARROW_QUERY`, so this component's shortcut gating, that CSS rule, and the tour's
 *  one-time read never drift apart. */
const NARROW_QUERY = "(max-width: 719.98px)";

/** Reactive `matchMedia` state (unlike `use-tour.ts`'s one-time read, this component's
 *  `enabled` must track the CURRENT width for as long as it stays mounted, since a
 *  resize across the breakpoint must re-register/unregister the shortcut). Mirrors
 *  `FxLayer.tsx`'s own `usePrefersReducedMotion` hook. */
function useNarrowScreen(): boolean {
  const [narrow, setNarrow] = useState<boolean>(() => window.matchMedia(NARROW_QUERY).matches);
  useEffect(() => {
    const media = window.matchMedia(NARROW_QUERY);
    setNarrow(media.matches); // re-sync: it may have changed between the initializer and mount
    const onChange = (): void => setNarrow(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return narrow;
}

/**
 * The key: Lines, Actors, and Sensors. Rendered once, as a sibling of the map region
 * — `.metro-key`'s CSS (not a JS width check) decides whether it shows as a left
 * rail (>=720px) or is hidden outright (<720px, where the floating chip's dialog
 * carries the same content instead, see the module doc).
 */
function MetroKey() {
  return (
    <div className="metro-key">
      <LegendSections />
    </div>
  );
}

interface MetroViewProps {
  /** Lifted selection handler (GH124-PLAN.md Checkpoint 4), forwarded to `MetroMap`. */
  onSelect: (selection: MapSelection) => void;
  /** The map region's ref, for the place dialog's focus-restore fallback (App owns
   *  the ref; `tabIndex={-1}` here makes it programmatically focusable without
   *  joining the Tab order, mirroring `DecisionsPanel.tsx`'s own panel ref). */
  mapRegionRef?: RefObject<HTMLDivElement | null> | undefined;
  /** Opens the mobile legend dialog (GH133-PLAN.md). App owns `legendOpen` and its
   *  exclusivity guard against the other overlays; this component only relays the
   *  chip's click, the same thin-relay role `onSelect`/`mapRegionRef` already play. */
  onOpenLegend?: (() => void) | undefined;
  /** The legend chip's ref, for `LegendDialog`'s focus-restore on close (App owns the
   *  ref, mirroring `mapRegionRef` above). */
  legendTriggerRef?: RefObject<HTMLButtonElement | null> | undefined;
}

export function MetroView({
  onSelect,
  mapRegionRef,
  onOpenLegend,
  legendTriggerRef,
}: MetroViewProps) {
  const isNarrow = useNarrowScreen();
  const { key: legendKey } = useShortcut({
    scope: "shell",
    id: "legend-open",
    onActivate: () => onOpenLegend?.(),
    enabled: isNarrow,
  });
  const badgeKey = isNarrow ? legendKey : undefined;
  return (
    <div className="metro-view">
      {/* Two grid children, not overlays: the map region (so the full map, Harbor to
          World's End, and every site, is never hidden under a panel) and the key,
          each placed by `.metro-view`'s CSS grid areas — no width check here. */}
      <div className="metro-map-region" ref={mapRegionRef} tabIndex={-1} data-tour="map">
        <MetroMap onSelect={onSelect} />
        <WaveOutcomeBanner />
        <button
          type="button"
          className="metro-legend-button"
          ref={legendTriggerRef}
          onClick={onOpenLegend}
          aria-label="Show legend"
          aria-keyshortcuts={badgeKey === undefined ? undefined : ariaKeyshortcut(badgeKey)}
        >
          <List aria-hidden="true" size={14} />
          Legend
          {badgeKey !== undefined ? <Kbd shortcutKey={badgeKey} /> : null}
        </button>
      </div>
      <MetroKey />
    </div>
  );
}
