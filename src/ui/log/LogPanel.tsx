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
 */
import { memo, useEffect } from "react";
import type { Speed } from "../../game/run-controller";
import { useGameStore } from "../../game/store";
import { LOG_QUEUE_MAX } from "../../game/tuning";
import type { RingEvent } from "../../sim/inspector";
import { severityFill } from "../hud/severity";
import { formatClock, formatRow } from "./formatters";

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
  const frozen = useGameStore((s) => s.transport.frozen);
  const speed = useGameStore((s) => s.transport.speed);
  const setFrozen = useGameStore((s) => s.setFrozen);
  const setSpeed = useGameStore((s) => s.setSpeed);

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

  return (
    <div className="log-panel">
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
        </div>
      </div>
      <div className="engine-bar">
        <div className="queue-bar">
          <div
            className="queue-bar-fill"
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
