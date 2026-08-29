/**
 * The dev-kit panel: the "bring your own editor" controls, mounted only under the
 * `DEV_KIT` build flag. The App loads it through the co-located `loadDevKitPanel`
 * gate (see `game/dev-flag.ts`), so this module is never a static input to the CDN
 * build and `verify:static` can prove its absence.
 *
 * One action, "Edit in my IDE", creates or activates the Scenario file, watches it, and
 * opens it in the OS default handler — the App wires those to the dev-host client.
 * Once a file is active the panel shows its path and a "Stop editing" control, which
 * disconnects the watch and unlocks the in-game editor again; a later "Edit in my IDE"
 * reconnects. A status line surfaces any host message.
 *
 * The richer dev state (status, path, message) lives here in local state, fed by the
 * client's `onState` through the App's `subscribe`, so no dev-specific state sits in
 * the shared store.
 */
import { useEffect, useState } from "react";
import type { DevState } from "../game/dev-host-client";

export interface DevKitPanelProps {
  /** Create or activate the Scenario file, open it in the IDE, and start the watch. */
  onEditInIde: () => void;
  /** Disconnect the watch, unlock the in-game editor, and clear the panel state. */
  onStopEditing: () => void;
  /** Register a listener for the client's dev state; returns an unsubscribe. */
  subscribe: (listener: (state: DevState) => void) => () => void;
}

const OFF_STATE: DevState = { status: "off", path: null, message: null };

export function DevKitPanel({ onEditInIde, onStopEditing, subscribe }: DevKitPanelProps) {
  const [dev, setDev] = useState<DevState>(OFF_STATE);
  const [pending, setPending] = useState(false);

  // Any dev state (a host answer or error) ends the in-flight window: the panel now
  // reflects the real state instead of the optimistic "Opening..." label.
  useEffect(
    () =>
      subscribe((state) => {
        setDev(state);
        setPending(false);
      }),
    [subscribe],
  );

  const editing = dev.path !== null;

  const onEdit = (): void => {
    // Guard against a double-click queuing duplicate POSTs before the host answers.
    setPending(true);
    onEditInIde();
  };

  return (
    <div className="devkit">
      <div className="devkit-bar">
        {editing ? (
          <button type="button" className="devkit-stop" onClick={onStopEditing}>
            Stop editing
          </button>
        ) : (
          <button type="button" className="devkit-edit" onClick={onEdit} disabled={pending}>
            {pending ? "Opening..." : "Edit in my IDE"}
          </button>
        )}
      </div>
      {editing ? <span className="devkit-path">{dev.path}</span> : null}
      {dev.message !== null ? (
        <span className="devkit-status" role="status">
          {dev.message}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The one export the App reads off the lazily loaded dev-kit panel module. It lives
 * here, beside the component, so the co-located loader in `game/dev-flag.ts` can name
 * the module's shape without `game/` importing a React type (see ARCHITECTURE.md:
 * `game/` may import React only in the store).
 */
export interface DevKitPanelModule {
  DevKitPanel: typeof DevKitPanel;
}
