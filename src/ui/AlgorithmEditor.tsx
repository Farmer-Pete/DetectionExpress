/**
 * The Algorithm editor: a textarea seeded with the store's source, a Run button,
 * and an error line bound to the store error. Editing writes the source back to
 * the store; Run asks the run controller to reload it. M2 keeps this minimal; the
 * briefing and richer feedback land in M3.
 *
 * While `sourceLocked`, an external source (the dev host watching a file) drives the
 * run: the textarea goes read-only and mirrors the pushed source, and the Run button
 * hides, since a manual reload would fight the watcher. This is a generic lock, not
 * dev code, so the static build keeps it (always unlocked there).
 *
 * "Download this level" is generic too, so it ships in every build: it saves the
 * current source as `detection-express-<slug>.js`, the same filename the dev host
 * writes, so a player on the CDN can hand-carry the file into a local dev kit.
 */
import { useGameStore } from "../game/store";
import { levelFileName } from "./levels";

interface AlgorithmEditorProps {
  /** Reload the current source and restart the run. */
  onRun: () => void;
  /** The current level's slug, for the download filename. */
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
    anchor.download = levelFileName(slug);
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
          Download this level
        </button>
        {sourceLocked ? null : (
          <button type="button" className="editor-run" onClick={onRun}>
            Run
          </button>
        )}
      </div>
      <textarea
        className="editor-code"
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
