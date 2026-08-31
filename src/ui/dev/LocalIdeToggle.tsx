/**
 * The `.local-ide` control, extracted from `App.tsx` (GH109-PLAN.md). Dumb and
 * presentational, in the `ModalHost` style: no state, just the ready/local-mode
 * branch `App` used to inline in the pipeline view's JSX. `useLocalIde` owns the
 * state and the handlers this component only renders.
 */
interface LocalIdeToggleProps {
  ready: boolean;
  localMode: boolean;
  onEnter: () => void;
  onStop: () => void;
}

export function LocalIdeToggle({ ready, localMode, onEnter, onStop }: LocalIdeToggleProps) {
  if (!ready) {
    return null;
  }
  return (
    <div className="local-ide">
      {localMode ? (
        <button type="button" onClick={onStop}>
          Stop editing
        </button>
      ) : (
        <button type="button" onClick={onEnter}>
          Edit in IDE
        </button>
      )}
    </div>
  );
}
