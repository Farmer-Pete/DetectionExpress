/**
 * The unified log panel (GH124-PLAN.md Checkpoint 5): one row per world-event ring
 * entry, newest first, across every sensor kind — kiosk, fare gate, TVM, train
 * tracker, door reader, door contact, platform camera, OCC console, network relay.
 * Reads `snapshot.worldEvents` through an array selector, the same pattern the panel
 * always used, just re-sourced off the wider ring instead of the scored-only one.
 *
 * Dropped in this checkpoint: the processing-frontier cursor, pending-row dimming,
 * and the queue bar (GH32-PLAN.md's cursor states no longer apply — there is no
 * single scored "processed" watermark to draw one against when every sensor logs
 * here, and the Metrics tab's own Queue gauge already covers that number). Kept:
 * Freeze and the speed control.
 *
 * A row is a button: clicking it opens the adaptive event dialog (`selectWorldEvent`,
 * `EventDialog.tsx`) on that row's world-log id, through the `onSelectEvent` prop
 * (`App.tsx` forwards a guarded wrapper; see `LogPanelProps` below). A scored kiosk
 * row also carries `data-scored-event-id`, a SEPARATE namespace from the row's own
 * `data-testid` world id — `FxLayer` anchors finding comets and cited-row
 * highlighting through that attribute, never the world id, so re-sourcing the log off
 * the wider ring never moves where a comet lands.
 *
 * The transport row also carries the wave readout (#38 juice item 1): "next
 * wave in Ns" (N quantized to a 30-game-second bucket, see `waveReadout`)
 * while calm, a pulsing "◈ WAVE INCOMING" while incoming, and nothing while a
 * wave is active or after the last one (no countdown to show). Both the
 * readout and the status announcement gate on
 * `snapshot.status === "running"` (F003): once a run has concluded (won or
 * failed) neither renders, since a wave reading from a stopped clock is stale,
 * not a live cue. That gate is about conclusion, not the transport freeze —
 * pausing (`transport.frozen`) leaves the readout showing the frozen reading,
 * since the run can still resume. That visible text is `aria-hidden` because
 * it ticks too fast to announce; a separate `role="status"` region carries
 * only the low-frequency phase change ("wave incoming", then "wave arrived"
 * once the wave starts), which fires at most a few times per run. On the
 * incoming -> active edge the panel's own column flashes once
 * (`useWavePhaseEdge` feeding its own `useOneShotFlag` call, one-shot
 * ownership: this component holds its own hook instance and clears
 * `.waveflash` itself, independent of App's `.shake`, which calls the same
 * shared hook from its own instance).
 *
 * The conclusion gate (F004+F006): ANIMATED cues — the flash edge — gate on
 * `snapshot.status === "running"`. `running` is derived once, early, and feeds
 * `useWavePhaseEdge` a `"calm"` input while not running, so a status flip alone can
 * never manufacture an edge; `running` is deliberately left out of `useOneShotFlag`'s
 * own token input (only `edgeToken` drives it), since folding it in there would
 * re-fire the last edge on a status flip instead of gating admission at the source.
 * This is about conclusion, never the transport freeze: pausing
 * (`transport.frozen`) leaves every cue live, since the run can still resume.
 * The flash render site itself also ANDs `flashing` with `running`, so an
 * ALREADY in-flight flash clears the instant a run concludes, instead of
 * running out its own timer over a frozen frame (CodeRabbit review).
 *
 * A scored row also reads its entry in the store's `flashes` map (T12, GH37-PLAN.md
 * "Comets"), keyed by its `scoredEventId`: FxLayer spawns one when the row is cited
 * evidence for a just-landed finding. The row's React `key` folds in the flash's
 * `gen`, so a re-spawn on the same row (a higher gen) remounts the node and restarts
 * the CSS keyframe, rather than extending whatever the old flash had already
 * animated.
 */
import { type CSSProperties, memo, type RefObject, useEffect, useRef } from "react";
import type { Speed } from "../../game/run-controller";
import { type FlashEntry, useGameStore } from "../../game/store";
import { GAME_SECONDS_PER_TICK } from "../../game/tuning";
import type { SimSnapshot } from "../../sim/snapshot";
import type { WorldLogEvent } from "../../sim/world-log";
import { sensorCodeFor } from "../../sim/world-log";
import { sensorIcon } from "../icons/sensor-icons";
import { useOneShotFlag } from "../wave/use-one-shot-flag";
import { useWavePhaseEdge } from "../wave/use-wave-phase-edge";
import { formatClock, toLogRow } from "./formatters";

/** Matches the CSS `waveflash` keyframes' 0.6s duration (`src/index.css`). */
const WAVEFLASH_MS = 600;

/**
 * The countdown's display bucket, in game-seconds (GH38 review round 4,
 * F014). `ticksUntilNext` is always a whole tick count, so ceiling it to a
 * whole second is a no-op: the text would still change on every ~50ms publish
 * sample, six game-seconds at a time. Per-second display stepping would not
 * fix that either — at 1x, game time runs `CLOCK_HZ * GAME_SECONDS_PER_TICK`
 * = 120 game-seconds per wall-second, so a once-per-second step still races
 * the sampler. Bucketing to 30 game-seconds instead steps the readout only a
 * handful of times per calm window. This value is a first-draft #40 tuning
 * knob, not load-bearing.
 */
const WAVE_COUNTDOWN_BUCKET_S = 30;

/**
 * The wave readout's text and urgency, or null when there is nothing to show
 * (active, or calm with no wave left). `incoming` drives the pulsing style.
 * The countdown quantizes to `WAVE_COUNTDOWN_BUCKET_S`-second buckets (see
 * that constant's comment for why a plain per-second ceil does not work).
 * Honest caveat, at the shipped tuning: the intro calm (`INTRO_TICKS`, 120)
 * genuinely counts down through the buckets (240s -> 90s), but a SUCCESSOR
 * wave's whole calm gap is `DRAIN_GAP_TICKS` (45), and every calm tick that
 * gap can produce buckets to the same constant "next wave in 90s" until the
 * phase flips to INCOMING. That is a consequence of `WAVE_COUNTDOWN_BUCKET_S`
 * (a #40 felt-pace knob) sized close to the gap, not a bug; this comment
 * records it, not fixes it.
 */
function waveReadout(wave: SimSnapshot["wave"]): { text: string; incoming: boolean } | null {
  if (wave.phase === "incoming") {
    return { text: "◈ WAVE INCOMING", incoming: true };
  }
  if (wave.ticksUntilNext !== null) {
    const rawSeconds = wave.ticksUntilNext * GAME_SECONDS_PER_TICK;
    const seconds = Math.ceil(rawSeconds / WAVE_COUNTDOWN_BUCKET_S) * WAVE_COUNTDOWN_BUCKET_S;
    return { text: `next wave in ${seconds}s`, incoming: false };
  }
  return null;
}

/**
 * The role="status" announcement: phase-mapped, never the ticking count, so a
 * screen reader hears one whole phrase per phase change instead of every
 * sample. "wave incoming" warns during the countdown; "wave arrived" fires
 * once the wave actually starts (GH38 review round 4, F007) — without it, a
 * screen reader user is warned but never learns the wave they were warned
 * about began. The text holds constant through the whole active phase, so it
 * announces exactly once at wave start, not on every publish sample. Calm
 * renders "", so the region falls silent between waves.
 */
function waveAnnouncement(
  phase: SimSnapshot["wave"]["phase"],
): "wave incoming" | "wave arrived" | "" {
  switch (phase) {
    case "incoming":
      return "wave incoming";
    case "active":
      return "wave arrived";
    case "calm":
      return "";
  }
}

/** The speed choices the transport offers, in ascending order, with their labels. */
const SPEEDS: ReadonlyArray<{ value: Speed; label: string }> = [
  { value: 0.5, label: "0.5x" },
  { value: 1, label: "1x" },
  { value: 2, label: "2x" },
];

/** True when a key event targets an editable element, so Space should not toggle. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
}

/** `CSSProperties` plus the one custom property a cited-row flash sets. */
interface CitedRowStyle extends CSSProperties {
  "--hunt-color"?: string;
}

interface LogRowProps {
  event: WorldLogEvent;
  /** Present while this row is cited evidence for a just-landed finding. Only a
   *  scored row (keyed by `scoredEventId`) can ever carry one. */
  flash: FlashEntry | undefined;
  onSelect: (id: number) => void;
}

const LogRow = memo(function LogRow({ event, flash, onSelect }: LogRowProps) {
  const view = toLogRow(event);
  const { Icon, token } = sensorIcon(sensorCodeFor(event.sensor));
  const classes = ["log-row", `log-row-${view.tone}`];
  if (flash) {
    classes.push("log-row-cited");
  }
  const style: CitedRowStyle | undefined = flash ? { "--hunt-color": flash.colorVar } : undefined;
  return (
    <button
      type="button"
      className={classes.join(" ")}
      data-testid={`log-row-${event.id}`}
      data-scored-event-id={event.scored ? event.scoredEventId : undefined}
      style={style}
      onClick={(clickEvent) => {
        // Safari does not focus a clicked <button> by default; force it so the event
        // dialog's open-effect can capture this row as its trigger to restore focus to
        // on close (mirrors FindingsPanel.tsx's FindingRowItem).
        clickEvent.currentTarget.focus();
        onSelect(event.id);
      }}
    >
      <span className="log-row-time">{formatClock(view.ts)}</span>
      <span className="log-row-sensor">
        <Icon size={14} color={token} aria-hidden="true" />
      </span>
      <span className="log-row-who">{view.who}</span>
      <span className="log-row-where">{view.where}</span>
      <span className="log-row-result">{view.result}</span>
    </button>
  );
});

interface LogPanelProps {
  /**
   * The event dialog's focus-fallback ref (GH124-PLAN.md Checkpoint 5, mirroring
   * `FindingsPanel`'s `panelRef` / GH34-35-PLAN.md decision 14): when a clicked row's
   * trigger is gone by the time the dialog closes, focus lands here instead. Defaults
   * to a locally-owned ref, so a bare `<LogPanel />` (an isolated test) still works.
   */
  panelRef?: RefObject<HTMLDivElement | null>;
  /**
   * The row-click opener. Defaults to the store's `selectWorldEvent` directly, so a
   * bare `<LogPanel />` (an isolated test) still works. `App.tsx` instead forwards a
   * guarded wrapper that no-ops while the side panel is open, mirroring the guard
   * `onMapSelect` already applies to the map's opener — the shell's `inert` gate
   * blocks a real pointer/keyboard click, but this is what enforces the "at most one
   * modal" invariant against any path not gated by inert.
   */
  onSelectEvent?: ((id: number) => void) | undefined;
}

export function LogPanel({
  panelRef: externalRef,
  onSelectEvent: externalOnSelectEvent,
}: LogPanelProps = {}) {
  const ownRef = useRef<HTMLDivElement>(null);
  const panelRef = externalRef ?? ownRef;
  const worldEvents = useGameStore((s) => s.snapshot.worldEvents);
  const wave = useGameStore((s) => s.snapshot.wave);
  const status = useGameStore((s) => s.snapshot.status);
  const frozen = useGameStore((s) => s.transport.frozen);
  const speed = useGameStore((s) => s.transport.speed);
  const flashes = useGameStore((s) => s.flashes);
  const setFrozen = useGameStore((s) => s.setFrozen);
  const setSpeed = useGameStore((s) => s.setSpeed);
  const storeSelectWorldEvent = useGameStore((s) => s.selectWorldEvent);
  const selectWorldEvent = externalOnSelectEvent ?? storeSelectWorldEvent;

  // Derived early, before the edge hook: gate on conclusion (won/failed), never
  // on the transport freeze (F003, F004+F006). A paused run can still resume,
  // so its frozen reading stays live; a concluded run cannot, so its cues must
  // stop.
  const running = status === "running";

  // One-shot ownership (GH38+40-PLAN.md, "Wave indicator + flash + shake"): this
  // panel owns its own `.waveflash` class and clears it itself, independent of
  // App's `.shake`. `edgeToken` changes exactly once per incoming -> active
  // edge; skip its initial `0` so mount never flashes. The hook's INPUT is
  // gated on `running`, not its output: feeding it `"calm"` while concluded
  // means a status flip alone can never manufacture an edge. `running` stays
  // out of the effect's own deps below (only `edgeToken` drives it) — adding it
  // there would re-fire the last edge on a status flip instead.
  const edgeToken = useWavePhaseEdge(running ? wave.phase : "calm");
  const flashing = useOneShotFlag(edgeToken, WAVEFLASH_MS);

  // The panel owns a Space-to-freeze listener: added on mount, removed on unmount. It
  // ignores key repeats and editable targets, and it reads the freeze state fresh from
  // the store so the closure never goes stale. When Space lands on any interactive
  // control (the Freeze button, a Speed button, a link) it stands down and lets that
  // control's native activation happen once; otherwise it toggles freeze and calls
  // preventDefault to stop the page from scrolling. Net effect: Space never fights a
  // focused control and toggles freeze exactly once from the panel background.
  //
  // It also bails while the store's `overlayOpen` is true (GH118-PLAN.md): this window
  // listener has no idea the shell is `inert` behind an open overlay (the side panel,
  // the intro, the trace dialog), so without this gate Space could resume a run the
  // player can't see or reach. Read fresh from `getState()`, same as `frozen`, so the
  // gate never goes stale either.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.code !== "Space" && event.key !== " ") {
        return;
      }
      if (event.repeat || isEditableTarget(event.target)) {
        return;
      }
      if (useGameStore.getState().overlayOpen) {
        return; // an overlay owns the run; the inert shell must not resume it
      }
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(
          'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable="true"], [role="button"], [role="checkbox"], [role="switch"], [role="tab"], [role="radio"], [role="menuitem"], [role="link"], [role="option"]',
        )
      ) {
        return; // let the focused control's native activation run; do not double it
      }
      event.preventDefault();
      setFrozen(!useGameStore.getState().transport.frozen);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setFrozen]);

  const newestFirst = worldEvents.slice().reverse();
  // `running` (F003) also gates the readout text: a concluded run's stale
  // reading must not keep showing.
  const readout = running ? waveReadout(wave) : null;

  return (
    <div
      ref={panelRef}
      className={flashing && running ? "log-panel waveflash" : "log-panel"}
      tabIndex={-1}
      data-tour="log"
    >
      <div className="log-header">
        <div className="transport">
          <button
            type="button"
            className={`transport-freeze${frozen ? " transport-freeze-on" : ""}`}
            aria-pressed={frozen}
            onClick={() => setFrozen(!frozen)}
          >
            <span className="transport-dot" aria-hidden="true" />
            Freeze
          </button>
          <div className="transport-speeds">
            {SPEEDS.map(({ value, label }) => {
              const active = speed === value;
              return (
                <button
                  key={value}
                  type="button"
                  className={`transport-speed${active ? " transport-speed-on" : ""}`}
                  aria-pressed={active}
                  onClick={() => setSpeed(value)}
                >
                  {label}
                </button>
              );
            })}
          </div>
          {readout ? (
            <span
              className={`wave-readout${readout.incoming ? " wave-readout-incoming" : ""}`}
              aria-hidden="true"
            >
              {readout.text}
            </span>
          ) : null}
          <span className="visually-hidden" role="status">
            {running ? waveAnnouncement(wave.phase) : ""}
          </span>
        </div>
      </div>
      <div className="log-stream">
        {newestFirst.map((event) => {
          // Only a scored row's world-log entry ever has a scoredEventId, and only
          // that id is ever a key in `flashes` (FxLayer anchors through it, not the
          // world id) — see the module doc.
          const flash =
            event.scoredEventId !== undefined ? flashes.get(event.scoredEventId) : undefined;
          // The key folds in the flash's gen, so a re-spawn on the same row (a higher
          // gen) remounts the node instead of extending the running keyframe.
          const key = flash ? `${event.id}:${flash.gen}` : event.id;
          return <LogRow key={key} event={event} flash={flash} onSelect={selectWorldEvent} />;
        })}
      </div>
    </div>
  );
}
