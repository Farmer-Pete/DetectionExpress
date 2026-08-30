/**
 * The Algorithm editor: a textarea seeded with the store's source, an Apply button,
 * a Reset to default button, and an error line bound to the store error. Editing writes
 * the source back to the store; Apply asks the run controller to reload it, which
 * dry-runs the edit (load + profile) before it restarts the live run, so a broken edit
 * leaves the running engine untouched and only shows on the error line. While the
 * dry-run is in flight (`runPending`) Apply disables and reads "Checking...". Reset to
 * default loads the reference source text back into the textarea; it does not run.
 *
 * While `sourceLocked`, a local-IDE file (hot-reloaded by the algorithms-hmr plugin)
 * drives the run: the textarea goes read-only and mirrors the loaded source, and the Apply
 * and Reset buttons hide, since a manual reload or edit would fight the hot-reload. This
 * is a generic lock, not dev code, so the production build keeps it (always unlocked there).
 *
 * "Download this Scenario" is generic too, so it ships in every build: it saves the
 * current source to a file, so a player can carry their engine into their own editor as a
 * starting point for `src/algorithms/<slug>.ts`.
 */
import { useGameStore } from "../game/store";
import { referenceSource } from "../sim/scenarios/kiosk-pin-attack/reference";
import { scenarioFileName } from "./scenarios";

interface AlgorithmEditorProps {
  /** Reload the current source and restart the run. */
  onRun: () => void;
  /** The current Scenario's slug, for the download filename. */
  slug: string;
}

export function AlgorithmEditor({ onRun, slug }: AlgorithmEditorProps) {
  const source = useGameStore((state) => state.source);
  const setAlgorithmSource = useGameStore((state) => state.setAlgorithmSource);
  const error = useGameStore((state) => state.error);
  const sourceLocked = useGameStore((state) => state.sourceLocked);
  const runPending = useGameStore((state) => state.runPending);

  const onDownload = (): void => {
    const blob = new Blob([source], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = scenarioFileName(slug);
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="editor">
      <div className="editor-bar">
        <span className="editor-title">Algorithm</span>
        <button type="button" className="editor-download" onClick={onDownload}>
          Download this Scenario
        </button>
        {sourceLocked ? null : (
          <>
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
          </>
        )}
      </div>
      <textarea
        className="editor-code"
        aria-label="Algorithm source"
        spellCheck={false}
        value={source}
        readOnly={sourceLocked}
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
