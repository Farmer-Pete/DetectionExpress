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
 */

import { List } from "lucide-react";
import type { RefObject } from "react";
import type { MapSelection } from "../game/store";
import { MetroMap } from "./MetroMap";
import { LegendSections } from "./metro/LegendSections";
import { WaveOutcomeBanner } from "./wave/WaveOutcomeBanner";

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
        >
          <List aria-hidden="true" size={14} />
          Legend
        </button>
      </div>
      <MetroKey />
    </div>
  );
}
