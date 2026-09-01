/**
 * The Algorithm editor: a textarea seeded with the store's source, an Apply button,
 * a Reset to default button, and an error line bound to the store error. Editing writes
 * the source back to the store; Apply asks the run controller to reload it, which
 * dry-runs the edit (load + profile) before it restarts the live run, so a broken edit
 * leaves the running engine untouched and only shows on the error line. While the
 * dry-run is in flight (`runPending`) Apply disables and reads "Checking...". Reset to
 * default loads the reference source text back into the textarea; it does not run.
 */
import { referenceSource } from "../game/engine-source";
import { useGameStore } from "../game/store";

interface AlgorithmEditorProps {
  /** Reload the current source and restart the run. */
  onRun: () => void;
}

export function AlgorithmEditor({ onRun }: AlgorithmEditorProps) {
  const source = useGameStore((state) => state.source);
  const setAlgorithmSource = useGameStore((state) => state.setAlgorithmSource);
  const error = useGameStore((state) => state.error);
  const runPending = useGameStore((state) => state.runPending);

  return (
    <div id="algorithm-editor" className="editor" tabIndex={-1}>
      <div className="editor-bar">
        <span className="editor-title">Algorithm</span>
        <button
          type="button"
          className="editor-reset"
          onClick={() => setAlgorithmSource(referenceSource)}
        >
          Reset to default
        </button>
        <button type="button" className="editor-apply" onClick={onRun} disabled={runPending}>
          {runPending ? "Checking..." : "Apply"}
        </button>
      </div>
      <textarea
        className="editor-code"
        aria-label="Algorithm source"
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
