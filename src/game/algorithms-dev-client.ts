/**
 * The dev-only local-IDE client (86-PLAN.md "Bootstrap and resolution", "Dev client
 * lifecycle"). It rides Vite's module-graph HMR channel: no custom transport, no seq,
 * no session token — Vite owns ordering and delivery. This module holds only the client
 * lifecycle and the frame guard; it touches no `import.meta`, so it is driven off the
 * browser by a fake channel, a fake store, and a fake `sessionStorage`. The App wires the
 * real `import.meta.hot` channel and the store behind an `import.meta.env.DEV` gate (see
 * `algorithms-dev-flag.ts`), so the production bundle carries none of it.
 *
 * Protocol (all custom HMR events):
 *
 * - The client subscribes by SLUG, not by path, because only the plugin can stat the
 *   filesystem. On entering local mode it registers its `algo:changed` listener, then
 *   sends `algo:hello { slug }`. The plugin resolves the active file and replies
 *   `algo:changed { slug, path, version }`, so local mode runs on entry with no save.
 * - On any create/change/delete under `src/algorithms/`, the plugin re-resolves the slug
 *   and pings the new `{ slug, path, version }`. A create of the preferred `<slug>.ts`
 *   is an active-selection change: the plugin now resolves to it, so the client imports
 *   it. A ping for any other slug is ignored.
 * - On a matching ping the client stores `{ path, version }` (the App derives the url-mode
 *   `AlgorithmSource` and its cache-busting URL) and triggers a run. The run controller
 *   awaits the import inside its generation-guarded epoch, so a reordered load cannot win.
 *
 * Lifecycle. Entering local mode snapshots the in-game `store.source` into
 * `sessionStorage` (so it survives a forced reload), locks the in-game editor, and
 * subscribes. "Stop editing" restores the snapshot and unlocks. A forced reload (Vite
 * reloads when the active file is deleted) re-enters from the persisted snapshot and
 * re-subscribes, so the reloaded page falls back to the default engine and a later stop
 * still restores the original text.
 *
 * A single session generation, bumped on every subscribe and on stop/dispose, guards the
 * frame handler: a frame whose epoch no longer matches is stale and is dropped, so a
 * late ping after a stop or a re-subscribe cannot apply.
 */
import type { ChangedFrame } from "./algorithms-resolve";

/**
 * The subset of Vite's HMR context the client uses. `import.meta.hot` satisfies it (the
 * App adapts it), and a test drives a fake. `off` is optional: the generation guard
 * already drops a stale handler's frames, so `off` only prevents a listener leak.
 */
export interface HotChannelLike {
  on(event: string, handler: (data: unknown) => void): void;
  off?(event: string, handler: (data: unknown) => void): void;
  send(event: string, data?: unknown): void;
}

/** The store slice the client drives. The App backs it with the zustand store. */
export interface DevClientStore {
  /** The current in-game editor source, snapshotted on enter and restored on stop. */
  getSource(): string;
  /** Restore the in-game editor source on stop. */
  setSource(source: string): void;
  /** The active local override, or null in source mode. The run reads this to choose. */
  setLocalAlgorithm(value: { path: string; version: number } | null): void;
  /** Lock the in-game editor while a local file drives the run. */
  setSourceLocked(locked: boolean): void;
}

/** The subset of `sessionStorage` the client persists its snapshot through. */
export interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface AlgorithmsDevClientDeps {
  /** The Scenario slug this client subscribes to. */
  slug: string;
  channel: HotChannelLike;
  store: DevClientStore;
  /** Trigger a run: the controller reloads from the store's current source choice. */
  run: () => void;
  session: SessionStorageLike;
}

export interface AlgorithmsDevClient {
  /** Enter local mode fresh: snapshot the in-game source, lock, and subscribe. */
  enter(): void;
  /** Re-enter from a persisted snapshot after a forced reload. Returns whether it did. */
  resume(): boolean;
  /** Stop editing: drop in-flight frames, restore the snapshot, and unlock. */
  stop(): void;
  /** Teardown on unmount: drop the listener, but keep the snapshot for a later reload. */
  dispose(): void;
}

/** The one export the App reads off the lazily loaded client module. */
export interface AlgorithmsDevClientModule {
  createAlgorithmsDevClient: (deps: AlgorithmsDevClientDeps) => AlgorithmsDevClient;
}

/** The `sessionStorage` key for the persisted local-mode snapshot. */
export const LOCAL_MODE_SNAPSHOT_KEY = "detection-express:algorithms-local-mode";

/** The in-game source snapshot persisted across a forced reload. */
interface LocalModeSnapshot {
  source: string;
}

/** A string primitive, by its tag rather than a representation check. */
function isString(value: unknown): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}

/** A finite number by tag, so a frame's `version` parses with no unsafe assertion. */
function isFiniteNumber(value: unknown): value is number {
  return Number.isFinite(value);
}

/** JSON-parse to an object, or null on malformed input. Contains the decode error. */
function parseObject(raw: string): object | null {
  try {
    const value = JSON.parse(raw);
    return value instanceof Object ? value : null;
  } catch {
    return null;
  }
}

/** Parse an `algo:changed` frame's payload, or null on a malformed or partial frame. */
function asChangedFrame(data: unknown): ChangedFrame | null {
  if (!(data instanceof Object) || !("slug" in data && "path" in data && "version" in data)) {
    return null;
  }
  const { slug, path, version } = data;
  if (isString(slug) && isString(path) && isFiniteNumber(version)) {
    return { slug, path, version };
  }
  return null;
}

/** Parse the persisted snapshot, or null when absent or malformed. */
function readSnapshot(session: SessionStorageLike): LocalModeSnapshot | null {
  const raw = session.getItem(LOCAL_MODE_SNAPSHOT_KEY);
  if (raw === null) {
    return null;
  }
  const value = parseObject(raw);
  if (value !== null && "source" in value && isString(value.source)) {
    return { source: value.source };
  }
  return null;
}

export function createAlgorithmsDevClient(deps: AlgorithmsDevClientDeps): AlgorithmsDevClient {
  const { slug, channel, store, run, session } = deps;

  let generation = 0;
  let currentHandler: ((data: unknown) => void) | null = null;

  const unsubscribe = (): void => {
    if (currentHandler !== null) {
      channel.off?.("algo:changed", currentHandler);
      currentHandler = null;
    }
  };

  // Register a fresh, epoch-stamped listener and bootstrap with `algo:hello`. The epoch
  // check drops any frame delivered after a later subscribe or a stop, so a stale ping
  // cannot apply even if `off` is unavailable.
  const subscribe = (): void => {
    unsubscribe();
    generation += 1;
    const epoch = generation;
    const handler = (data: unknown): void => {
      if (epoch !== generation) {
        return; // stale: a stop, switch, or re-subscribe bumped the generation
      }
      const frame = asChangedFrame(data);
      if (frame === null || frame.slug !== slug) {
        return; // malformed, or a ping for another algorithm: ignore
      }
      store.setLocalAlgorithm({ path: frame.path, version: frame.version });
      run();
    };
    currentHandler = handler;
    channel.on("algo:changed", handler);
    channel.send("algo:hello", { slug });
  };

  return {
    enter(): void {
      // Snapshot the in-game source ONCE. A re-entry over an already-persisted snapshot
      // (a forced reload) must keep the original, not overwrite it with the post-reload
      // default text.
      if (session.getItem(LOCAL_MODE_SNAPSHOT_KEY) === null) {
        const snapshot: LocalModeSnapshot = { source: store.getSource() };
        session.setItem(LOCAL_MODE_SNAPSHOT_KEY, JSON.stringify(snapshot));
      }
      store.setSourceLocked(true);
      subscribe();
    },

    resume(): boolean {
      if (readSnapshot(session) === null) {
        return false; // no local-mode session to restore
      }
      store.setSourceLocked(true);
      subscribe();
      return true;
    },

    stop(): void {
      generation += 1; // any in-flight frame is now stale
      unsubscribe();
      const snapshot = readSnapshot(session);
      store.setLocalAlgorithm(null);
      if (snapshot !== null) {
        store.setSource(snapshot.source); // restore the in-game editor text
      }
      store.setSourceLocked(false);
      session.removeItem(LOCAL_MODE_SNAPSHOT_KEY);
    },

    dispose(): void {
      generation += 1;
      unsubscribe();
      // No restore and no session clear: an unmount (including a forced reload's
      // teardown) must leave the snapshot so the reloaded page can resume local mode.
    },
  };
}
