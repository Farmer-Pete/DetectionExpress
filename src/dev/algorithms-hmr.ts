/**
 * `algorithms-hmr` — the dev-only Vite plugin that carries the local-IDE hot-reload
 * loop (86-PLAN.md "Mechanism"). It rides Vite's own module-graph HMR channel: there is
 * no custom transport, no seq, no session token. Vite owns ordering and delivery.
 *
 * It holds ONE monotonic version counter (the only source of versioning). It answers a
 * bootstrap `algo:hello { slug }` by resolving the active file for that slug — the player
 * override `src/algorithms/<slug>.ts` when it exists on disk, else the default engine —
 * and replying `algo:changed { slug, path, version }` to the asking socket. On any
 * create/change/delete under `src/algorithms/`, it bumps the version and re-pings every
 * subscribed slug with its freshly resolved active file, so an override create/delete
 * switches the active file server-side.
 *
 * The slug is validated against `^[a-z0-9-]{1,64}$` and the resolved override path is
 * confirmed to sit directly under `src/algorithms/` before any `fs` read; an invalid slug
 * never touches the filesystem. `handleHotUpdate` returns `[]` for files under
 * `src/algorithms/`, so Vite's default full reload is suppressed and the client's
 * cache-busting re-import is the only update path.
 *
 * The framing and resolution logic is the pure module `game/algorithms-resolve.ts`; this
 * file is only the Vite wiring, so it needs no unit test. It runs in Node (the Vite config
 * context) and is never a browser input.
 */
import fs from "node:fs";
import path from "node:path";
import type { HmrContext, ModuleNode, Plugin, ViteDevServer, WebSocketClient } from "vite";
import {
  ALGORITHMS_DIR,
  buildChangedFrame,
  createVersionCounter,
  isValidAlgorithmSlug,
  resolveActiveFile,
} from "../game/algorithms-resolve.ts";

const HELLO_EVENT = "algo:hello";
const CHANGED_EVENT = "algo:changed";
// The filesystem subdirectory, derived from the shared root-relative URL prefix
// (`/src/algorithms`) so the watched path and the resolver's served path cannot drift.
const ALGORITHMS_SUBDIR = ALGORITHMS_DIR.slice(1);

/** A string primitive, by its tag rather than a `typeof` representation check. */
function isString(value: unknown): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}

/** Read the slug off a bootstrap `algo:hello` payload, or null on a malformed one. */
function readHelloSlug(data: unknown): string | null {
  if (!(data instanceof Object) || !("slug" in data)) {
    return null;
  }
  const { slug } = data;
  return isString(slug) ? slug : null;
}

export function algorithmsHmr(): Plugin {
  const version = createVersionCounter();
  // Every slug any client has asked about. Re-pinged on each filesystem change so an
  // override create/delete flips a subscribed slug's active file for us.
  const subscribed = new Set<string>();
  let projectRoot = process.cwd();

  const algorithmsDir = (): string => path.resolve(projectRoot, ALGORITHMS_SUBDIR);

  // Only ever called with an already-validated slug (resolveActiveFile validates before
  // calling), but confirm the resolved path stays directly under src/algorithms/ as
  // defense in depth before the stat.
  const overrideExists = (slug: string): boolean => {
    const dir = algorithmsDir();
    const file = path.resolve(dir, `${slug}.ts`);
    if (path.dirname(file) !== dir) {
      return false; // never escapes src/algorithms/
    }
    return fs.existsSync(file);
  };

  const pingSlug = (
    target: { send(event: string, payload?: unknown): void },
    slug: string,
    at: number,
  ): void => {
    const active = resolveActiveFile(slug, overrideExists);
    if (active === null) {
      return; // an invalid slug: it never touched the filesystem
    }
    target.send(CHANGED_EVENT, buildChangedFrame(slug, active, at));
  };

  const isUnderAlgorithmsDir = (file: string): boolean =>
    path.dirname(path.resolve(file)) === algorithmsDir();

  return {
    name: "detection-express:algorithms-hmr",
    apply: "serve",

    configResolved(config): void {
      projectRoot = config.root;
    },

    configureServer(server: ViteDevServer): void {
      // Bootstrap: resolve the asking client's slug and reply to that socket alone.
      server.ws.on(HELLO_EVENT, (data: unknown, client: WebSocketClient): void => {
        const slug = readHelloSlug(data);
        if (slug === null || !isValidAlgorithmSlug(slug)) {
          return; // ignore a malformed or invalid slug; never track it or touch the fs
        }
        subscribed.add(slug);
        pingSlug(client, slug, version.current());
      });

      // Any create/change/delete under src/algorithms/ bumps the one counter and
      // re-pings every subscribed slug with its freshly resolved active file. Deletes
      // and creates are watcher-only (a brand-new or vanished file is not a tracked
      // module), so the watcher is the reliable source; handleHotUpdate only suppresses
      // the default reload.
      const onFsEvent = (file: string): void => {
        if (!isUnderAlgorithmsDir(file)) {
          return;
        }
        const at = version.bump();
        for (const slug of subscribed) {
          pingSlug(server.ws, slug, at);
        }
      };
      server.watcher.on("add", onFsEvent);
      server.watcher.on("change", onFsEvent);
      server.watcher.on("unlink", onFsEvent);
    },

    handleHotUpdate(ctx: HmrContext): Array<ModuleNode> | undefined {
      if (isUnderAlgorithmsDir(ctx.file)) {
        return []; // suppress Vite's default reload; the ping drives the client re-import
      }
      return undefined; // any other file: let Vite handle it normally
    },
  };
}
