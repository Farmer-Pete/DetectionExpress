/**
 * The Algorithm editor: a textarea seeded with the store's source, a Run button,
 * an Apply Optimization button, and an error line bound to the store error. Editing
 * writes the source back to the store; Run asks the run controller to reload it.
 * Apply Optimization swaps the naive default for the incremental tally in one edit,
 * the small change the player makes to survive the peak (GH3-PLAN.md section 13).
 *
 * While `sourceLocked`, a local-IDE file (hot-reloaded by the algorithms-hmr plugin)
 * drives the run: the textarea goes read-only and mirrors the loaded source, and the Run
 * and Apply Optimization buttons hide, since a manual reload or edit would fight the
 * hot-reload. This is a generic lock, not dev code, so the production build keeps it
 * (always unlocked there).
 *
 * "Download this Scenario" is generic too, so it ships in every build: it saves the
 * current source to a file, so a player can carry their engine into their own editor as a
 * starting point for `src/algorithms/<slug>.ts`.
 */
import { useGameStore } from "../game/store";
import { optimizationSource } from "../sim/scenarios/kiosk-pin-attack/optimization";
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
              className="editor-optimize"
              onClick={() => setAlgorithmSource(optimizationSource)}
            >
              Apply Optimization
            </button>
            <button type="button" className="editor-run" onClick={onRun}>
              Run
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
