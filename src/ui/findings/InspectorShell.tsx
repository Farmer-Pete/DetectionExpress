/**
 * The inspector shell (S3): a two-column layout with the raw stream on the left and
 * the findings on the right, plus a stubbed trace-overlay mount. The App renders it
 * where the node canvas used to sit. Growing it to the full three-column layout later
 * is a container change, not a panel rewrite.
 *
 * The shell owns the Esc-to-deselect listener. It sits on the shell container, so it
 * fires only for keydowns from within the shell (focus inside), and it yields when the
 * event was already handled (`defaultPrevented`). So it never steals Esc from the
 * editor or the intro overlay, both of which live outside the shell.
 */
import { useGameStore } from "../../game/store";
import { FindingsPanel } from "./FindingsPanel";

export function InspectorShell() {
  const clearSelection = useGameStore((state) => state.clearSelection);

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (event.key === "Escape" && !event.defaultPrevented) {
      clearSelection();
    }
  };

  return (
    <section className="inspector-shell" aria-label="Inspector" onKeyDown={onKeyDown}>
      <div className="inspector-stream">
        <p className="inspector-stream-note">T7 &mdash; raw stream, coming</p>
      </div>
      <FindingsPanel />
      <TraceOverlayMount />
    </section>
  );
}

/** T9's trace overlay mounts here. It renders nothing yet. */
function TraceOverlayMount() {
  return null;
}
