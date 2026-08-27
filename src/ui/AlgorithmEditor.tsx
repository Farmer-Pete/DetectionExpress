/**
 * The Algorithm editor: a textarea seeded with the store's source, a Run button,
 * and an error line bound to the store error. Editing writes the source back to
 * the store; Run asks the run controller to reload it. M2 keeps this minimal; the
 * briefing and richer feedback land in M3.
 */
import { useGameStore } from "../game/store";

interface AlgorithmEditorProps {
  /** Reload the current source and restart the run. */
  onRun: () => void;
}

export function AlgorithmEditor({ onRun }: AlgorithmEditorProps) {
  const source = useGameStore((state) => state.source);
  const setAlgorithmSource = useGameStore((state) => state.setAlgorithmSource);
  const error = useGameStore((state) => state.error);

  return (
    <div className="editor">
      <div className="editor-bar">
        <span className="editor-title">Algorithm</span>
        <button type="button" className="editor-run" onClick={onRun}>
          Run
        </button>
      </div>
      <textarea
        className="editor-code"
        spellCheck={false}
        value={source}
        onChange={(event) => setAlgorithmSource(event.target.value)}
      />
      {error ? (
        <div className="editor-error" role="alert">
          {error.phase}: {error.message}
        </div>
      ) : null}
    </div>
  );
}
