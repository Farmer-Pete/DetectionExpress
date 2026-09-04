/**
 * The Algorithm editor: a textarea seeded with the store's source, an Apply button,
 * a Reset to default button, and an error line bound to the store error. Editing writes
 * the source back to the store; Apply asks the run controller to reload it, which
 * dry-runs the edit (load + profile) before it restarts the live run, so a broken edit
 * leaves the running engine untouched and only shows on the error line. While the
 * dry-run is in flight (`runPending`) Apply disables and reads "Checking...". Reset to
 * default loads the reference source text back into the textarea; it does not run.
 *
 * GH137-PLAN.md M2: Reset ("R") and Apply ("A", `enabled={active && !runPending}`,
 * mirroring its own `disabled`) carry the `sidepanel:algorithm` scope's shortcuts.
 * `active` defaults to `true` so a bare/standalone render (every pre-existing test)
 * behaves exactly as before; `SidePanel.tsx`, the real mount site, always passes
 * `active={tab === "algorithm"}` — this component is one of three tabpanels that stay
 * mounted (just `hidden`) while another tab is active, so `active` mirrors that real
 * visibility the same way a hidden tabpanel's controls are meant to (`use-shortcut.ts`).
 * Apply's badge renders whenever the button itself renders and carries an assigned
 * key — including while `runPending` (code review MINOR fix: hiding it there hid the
 * discovery hint exactly when a player might wonder whether "A" still does anything).
 * `enabled={active && !runPending}` on the `useShortcut` call, not the badge, is what
 * actually keeps the dispatcher from firing while a run is pending — the same way the
 * native `disabled={runPending}` keeps a click from firing.
 */
import { referenceSource } from "../game/engine-source";
import { useGameStore } from "../game/store";
import { Kbd } from "./shortcuts/Kbd";
import { ariaKeyshortcut } from "./shortcuts/shortcuts.data";
import { useShortcut } from "./shortcuts/use-shortcut";

interface AlgorithmEditorProps {
  /** Reload the current source and restart the run. */
  onRun: () => void;
  /** Whether the Algorithm tab is the currently-selected tab, so its shortcuts fire
   *  only while genuinely visible. Defaults to `true` for a standalone render. */
  active?: boolean | undefined;
}

export function AlgorithmEditor({ onRun, active = true }: AlgorithmEditorProps) {
  const source = useGameStore((state) => state.source);
  const setAlgorithmSource = useGameStore((state) => state.setAlgorithmSource);
  const error = useGameStore((state) => state.error);
  const runPending = useGameStore((state) => state.runPending);

  const resetToDefault = (): void => setAlgorithmSource(referenceSource);
  const { key: resetKey } = useShortcut({
    scope: "sidepanel:algorithm",
    id: "reset",
    onActivate: resetToDefault,
    enabled: active,
  });
  const { key: applyKey } = useShortcut({
    scope: "sidepanel:algorithm",
    id: "apply",
    onActivate: onRun,
    enabled: active && !runPending,
  });

  return (
    <div id="algorithm-editor" className="editor" tabIndex={-1}>
      <div className="editor-bar">
        <span className="editor-title">Algorithm</span>
        <button
          type="button"
          className="editor-reset"
          aria-keyshortcuts={resetKey === undefined ? undefined : ariaKeyshortcut(resetKey)}
          onClick={resetToDefault}
        >
          Reset to default
          {resetKey !== undefined ? <Kbd shortcutKey={resetKey} /> : null}
        </button>
        <button
          type="button"
          className="editor-apply"
          aria-keyshortcuts={applyKey === undefined ? undefined : ariaKeyshortcut(applyKey)}
          onClick={onRun}
          disabled={runPending}
        >
          {runPending ? "Checking..." : "Apply"}
          {applyKey !== undefined ? <Kbd shortcutKey={applyKey} /> : null}
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
