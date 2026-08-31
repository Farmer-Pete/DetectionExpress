/**
 * The log panel: one row per Event, newest first, with a processing-frontier
 * cursor and a queue bar. Reads the store's `events`, `processed`, and
 * `admitted` through primitive/array selectors, the same pattern as the Hud.
 *
 * The cursor has three states (see GH32-PLAN.md, "The panel"):
 *   1. Caught up (`processed === admitted`): no cursor, no sticky bar.
 *   2. Cursor in the ring: the row with `event.id === processed` gets the
 *      cursor marker.
 *   3. Cursor evicted: queued is positive but no visible row has
 *      `id === processed` (the ring dropped it, the ring is empty, or the
 *      next cursor event has not normalized yet). A sticky bar pinned to the
 *      stream's bottom reads "engine N behind".
 * State 3 is decided purely from `events`/`processed`/`admitted`, never from
 * DOM measurement.
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
 * shared hook from its own instance). The queue bar also gains a
 * `queue-bar-danger` pulse class at danger severity (juice item 2).
 *
 * The conclusion gate (F004+F006): severity COLORS persist on the frozen
 * terminal frame (`severityFill` stays ungated), but ANIMATED cues — the
 * flash edge and the danger pulse — gate on `snapshot.status === "running"`.
 * `running` is derived once, early, and feeds `useWavePhaseEdge` a `"calm"`
 * input while not running, so a status flip alone can never manufacture an
 * edge; `running` is deliberately left out of `useOneShotFlag`'s own token
 * input (only `edgeToken` drives it), since folding it in there would re-fire
 * the last edge on a status flip instead of gating admission at the source.
 * This is about conclusion, never the transport freeze: pausing
 * (`transport.frozen`) leaves every cue live, since the run can still resume.
 * The flash render site itself also ANDs `flashing` with `running`, so an
 * ALREADY in-flight flash clears the instant a run concludes, instead of
 * running out its own timer over a frozen frame (CodeRabbit review).
 */
import { memo, useEffect } from "react";
import type { Speed } from "../../game/run-controller";
import { useGameStore } from "../../game/store";
import { GAME_SECONDS_PER_TICK, LOG_QUEUE_MAX } from "../../game/tuning";
import type { RingEvent } from "../../sim/inspector";
import type { SimSnapshot } from "../../sim/snapshot";
import { severityFill, severityLevel } from "../hud/severity";
import { useOneShotFlag } from "../wave/use-one-shot-flag";
import { useWavePhaseEdge } from "../wave/use-wave-phase-edge";
import { formatRow } from "./formatters";

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

/** `ts` is game seconds. Formats as an mm:ss clock; the formatter never reads time. */
function formatClock(ts: number): string {
  const totalSeconds = Math.max(0, Math.floor(ts));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** True when a key event targets an editable element, so Space should not toggle. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
}

interface LogRowProps {
  event: RingEvent;
  pending: boolean;
  cursor: boolean;
}

const LogRow = memo(function LogRow({ event, pending, cursor }: LogRowProps) {
  const view = formatRow(event.endpoint, event.raw);
  const classes = ["log-row", `log-row-${view.tone}`];
  if (pending) {
    classes.push("log-row-pending");
  }
  if (cursor) {
    classes.push("log-row-cursor");
  }
  return (
    <div className={classes.join(" ")} data-testid={`log-row-${event.id}`}>
      <span className="log-row-time">{formatClock(event.ts)}</span>
      <span className="log-row-who">{view.who}</span>
      <span className="log-row-where">{view.where}</span>
      <span className="log-row-result">{view.result}</span>
    </div>
  );
});

export function LogPanel() {
  const events = useGameStore((s) => s.snapshot.events);
  const processed = useGameStore((s) => s.snapshot.processed);
  const admitted = useGameStore((s) => s.snapshot.admitted);
  const wave = useGameStore((s) => s.snapshot.wave);
  const status = useGameStore((s) => s.snapshot.status);
  const frozen = useGameStore((s) => s.transport.frozen);
  const speed = useGameStore((s) => s.transport.speed);
  const setFrozen = useGameStore((s) => s.setFrozen);
  const setSpeed = useGameStore((s) => s.setSpeed);

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
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.code !== "Space" && event.key !== " ") {
        return;
      }
      if (event.repeat || isEditableTarget(event.target)) {
        return;
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

  const queued = admitted - processed;
  const frac = Math.max(0, Math.min(1, queued / LOG_QUEUE_MAX));

  const caughtUp = processed === admitted;
  const cursorVisible = !caughtUp && events.some((event) => event.id === processed);
  const showSticky = !caughtUp && !cursorVisible;

  const newestFirst = events.slice().reverse();
  // `running` (F003) also gates the readout text: a concluded run's stale
  // reading must not keep showing.
  const readout = running ? waveReadout(wave) : null;
  // severityFill (the bar's color) stays ungated — that's the persistent color
  // cue (F004+F006) — but the pulse is animated, so it gates on `running` too.
  const dangerPulse = running && severityLevel(frac) === "danger";

  return (
    <div className={flashing && running ? "log-panel waveflash" : "log-panel"}>
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
      <div className="engine-bar">
        <div className="queue-bar">
          <div
            className={dangerPulse ? "queue-bar-fill queue-bar-danger" : "queue-bar-fill"}
            data-testid="queue-bar-fill"
            style={{ width: `${frac * 100}%`, background: severityFill(frac) }}
          />
        </div>
        <span className="queue-count">{queued} queued</span>
      </div>
      <div className="log-stream">
        {newestFirst.map((event) => (
          <LogRow
            key={event.id}
            event={event}
            pending={event.id >= processed}
            cursor={!caughtUp && event.id === processed}
          />
        ))}
        {showSticky ? (
          <div className="log-sticky" data-testid="log-sticky">
            engine {queued} behind
          </div>
        ) : null}
      </div>
    </div>
  );
}
