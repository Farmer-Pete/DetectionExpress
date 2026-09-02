/**
 * The event dialog (GH124-PLAN.md Checkpoint 5): the adaptive detail modal for
 * whatever row the player last clicked in the unified log or a place dialog's scoped
 * log. It renders only while the map/event dialog stack's TOP entry
 * (`topMapDialogEntry`) is an `"event"` entry, reading the stack and the live
 * `snapshot` straight from the store, builds `eventDetail` fresh each render, so its
 * content tracks the running sim. Like `PlaceDialog`, opening it does NOT freeze the
 * engine — `App`'s `modalOpen` still makes the shell `inert`, but the sim keeps
 * stepping underneath.
 *
 * The store reconciles the stack's `"event"` entries on every `setSnapshot`
 * (mirroring `selection`/`decisionSelection`): the moment the ring evicts this row's
 * entry, wherever it sits in the stack, the store filters it out. When it was the top
 * entry, this component stops rendering (or the entry beneath it takes over), which is
 * the "close on evict" contract — there is no separate close-detection effect here.
 *
 * The backdrop, header (Back and Close controls), Escape/Tab handling, outside-click
 * dismissal, and focus lifecycle all live in the shared `MapDialogShell`, which
 * `PlaceDialog` renders too, so the two never drift. This component only picks its own
 * visibility off the stack's top entry, builds its header slots (icon, title, meta
 * badge) and its adaptive body, and hands them to the shell. `fallbackFocusRef` (the
 * log panel, wired by `App`), `rootTriggerRef`, and `rootFallbackFocusRef` pass
 * straight through to the shell's focus wiring (see `dialog-stack-focus.ts` for why
 * the root trigger and its fallback are shared with `PlaceDialog` rather than captured
 * independently by each dialog).
 *
 * Every detail kind's "Open place" link (`OpenPlaceButton` below, common to a scored
 * kiosk reading, one whose scored detail has aged out of the inspector ring, and a
 * raw/otherwise reading, since every `WorldLogEvent` carries a `placeId` regardless of
 * kind) calls `openPlaceFromEvent`, which PUSHES a place entry on top of this one
 * instead of replacing it, so a later Back returns here.
 */
import type { RefObject } from "react";
import { sensorCatalogueEntry } from "../../game/sensor-catalogue";
import { topMapDialogEntry, useGameStore } from "../../game/store";
import type { MapNodeId } from "../../sim/world/presence";
import { placeName } from "../../sim/world/world";
import { sensorCodeFor } from "../../sim/world-log";
import { sensorIcon } from "../icons/sensor-icons";
import { MapDialogShell } from "../MapDialogShell";
import { eventDetail } from "./event-detail";
import { formatClock, sensorLabel } from "./formatters";

interface EventDialogProps {
  /** Focus-restore fallback for when the root trigger is no longer connected — used
   *  only when THIS dialog roots the session, via `rootFallbackFocusRef` below (see
   *  `dialog-stack-focus.ts`). */
  fallbackFocusRef: RefObject<HTMLElement | null>;
  /** Shared with `PlaceDialog` (owned by `App`): the element that triggered the
   *  current dialog-stack session's very first, "outside", open — see
   *  `dialog-stack-focus.ts` for why this must be shared rather than captured
   *  independently by each dialog. */
  rootTriggerRef: RefObject<Element | null>;
  /** Shared with `PlaceDialog` (owned by `App`): the ROOT session's own fallback
   *  focus ref, captured alongside `rootTriggerRef` above so a full close restores to
   *  whichever dialog opened the session, not whichever one is on top when it closes
   *  — see `dialog-stack-focus.ts`. */
  rootFallbackFocusRef: RefObject<RefObject<HTMLElement | null> | null>;
}

export function EventDialog({
  fallbackFocusRef,
  rootTriggerRef,
  rootFallbackFocusRef,
}: EventDialogProps) {
  const stack = useGameStore((state) => state.mapDialogStack);
  const snapshot = useGameStore((state) => state.snapshot);
  const openPlaceFromEvent = useGameStore((state) => state.openPlaceFromEvent);

  const top = topMapDialogEntry(stack);
  const open = top !== null && top.kind === "event";
  const eventId = open ? top.id : null;
  const ev = eventId === null ? undefined : snapshot.worldEvents.find((e) => e.id === eventId);
  const detail =
    ev === undefined
      ? null
      : eventDetail(ev, snapshot.events, snapshot.findings, snapshot.decisions);

  // `ev`/`detail` are both null while closed, or (defensively) if the selected id
  // somehow named nothing live — reconciliation should make this unreachable in
  // practice, mirroring PlaceDialog's own defensive-only branch.
  if (ev === undefined || detail === null) {
    return null;
  }

  const { Icon, token } = sensorIcon(sensorCodeFor(ev.sensor));

  return (
    <MapDialogShell
      ariaLabel={`${sensorLabel(ev.sensor)} reading`}
      title={sensorLabel(ev.sensor)}
      icon={<Icon className="place-overlay-icon" size={20} color={token} aria-hidden="true" />}
      meta={<span className="place-meta-badge">{formatClock(ev.ts)}</span>}
      className="event-overlay"
      stackLength={stack.length}
      fallbackFocusRef={fallbackFocusRef}
      rootTriggerRef={rootTriggerRef}
      rootFallbackFocusRef={rootFallbackFocusRef}
    >
      {/* The sensor's sensors.data description, sourced from the catalogue, never
       *  generated (GH127-PLAN.md M3). The Raw/Normalized blobs below stay untouched. */}
      <p className="event-description">{sensorCatalogueEntry(ev.sensor).description}</p>
      {detail.kind === "scored" ? (
        <>
          <EventJsonSection title="Raw" value={detail.raw} />
          <EventJsonSection title="Normalized" value={detail.normalized} />
          <CitationsSection findings={detail.citingFindings} decisions={detail.citingDecisions} />
        </>
      ) : detail.kind === "scored-evicted" ? (
        <>
          <EventJsonSection title="Raw" value={detail.raw} />
          <p className="event-detail-note" data-testid="event-detail-evicted-note">
            Normalized detail no longer retained.
          </p>
          <CitationsSection findings={detail.citingFindings} decisions={detail.citingDecisions} />
        </>
      ) : (
        <>
          <EventJsonSection title="Raw" value={detail.raw} />
          <section className="place-devices" aria-label="Source">
            <h3 className="place-section-title">Source</h3>
            <p className="event-detail-source">
              {detail.source.actorId !== undefined ? `${detail.source.actorId} at ` : ""}
              {placeName(detail.source.placeId)}
            </p>
          </section>
        </>
      )}
      <OpenPlaceButton placeId={ev.placeId} onOpenPlace={openPlaceFromEvent} />
    </MapDialogShell>
  );
}

/**
 * The "Open place" link: common to every detail kind, not just the raw/otherwise
 * branch, since every `WorldLogEvent` carries a `placeId` regardless of whether the
 * reading was scored. Clicking it PUSHES a place entry naming `placeId` onto the
 * map/event dialog stack, on top of the event dialog it was clicked from, so a Back
 * returns to that event.
 */
function OpenPlaceButton({
  placeId,
  onOpenPlace,
}: {
  placeId: MapNodeId;
  onOpenPlace: (placeId: MapNodeId) => void;
}) {
  return (
    <button type="button" className="event-open-place" onClick={() => onOpenPlace(placeId)}>
      Open place
    </button>
  );
}

/** One raw/normalized JSON block, matching TraceOverlay's `<pre>` cards. */
function EventJsonSection({ title, value }: { title: string; value: unknown }) {
  return (
    <section className="place-devices" aria-label={title}>
      <h3 className="place-section-title">{title}</h3>
      <pre className="trace-card-raw">{JSON.stringify(value, null, 2)}</pre>
    </section>
  );
}

/** The findings/decisions that cite this scored event, when any do. */
function CitationsSection({
  findings,
  decisions,
}: {
  findings: readonly { seq: number; reason: string }[];
  decisions: readonly { seq: number; outcome: string }[];
}) {
  if (findings.length === 0 && decisions.length === 0) {
    return null;
  }
  return (
    <section className="place-actors" aria-label="Citations">
      <h3 className="place-section-title">Cited by</h3>
      <ul className="place-actor-list">
        {findings.map((finding) => (
          <li className="place-actor-row" key={`finding-${finding.seq}`}>
            finding · {finding.reason}
          </li>
        ))}
        {decisions.map((decision) => (
          <li className="place-actor-row" key={`decision-${decision.seq}`}>
            decision · {decision.outcome}
          </li>
        ))}
      </ul>
    </section>
  );
}
