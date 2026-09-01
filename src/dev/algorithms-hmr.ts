/**
 * `algorithms-hmr` — the dev-only Vite plugin that carries the local-IDE hot-reload
 * loop. It rides Vite's own module-graph HMR channel: there is no custom transport, no
 * seq, no session token. Vite owns ordering and delivery.
 *
 * One engine, not one algorithm per slug. It holds ONE monotonic version counter (the
 * only source of versioning). It answers a bootstrap `algo:hello` by resolving the
 * active engine file — the fixed override `src/algorithms/engine.ts` when it exists on
 * disk, else the default engine — and replying `algo:changed { path, version }` to the
 * asking socket. On any create/change/delete under `src/algorithms/`, it bumps the
 * version and re-pings every connected client with the freshly resolved active file, so
 * an override create/delete switches the active file server-side.
 *
 * The override path is a compile-time constant, so there is no slug and no traversal
 * surface. `handleHotUpdate` returns `[]` for files under `src/algorithms/`, so Vite's
 * default full reload is suppressed and the client's cache-busting re-import is the only
 * update path.
 *
 * The framing and resolution logic is the pure module `game/algorithms-resolve.ts`; this
 * file is only the Vite wiring, so it needs no unit test. It runs in Node (the Vite config
 * context) and is never a browser input.
 */
import fs from "node:fs";
import path from "node:path";
import type { HmrContext, ModuleNode, Plugin, ViteDevServer } from "vite";
import {
  ALGORITHMS_DIR,
  buildChangedFrame,
  createVersionCounter,
  ENGINE_OVERRIDE_PATH,
  resolveActiveFile,
} from "../game/algorithms-resolve.ts";

const HELLO_EVENT = "algo:hello";
const CHANGED_EVENT = "algo:changed";
// The filesystem subdirectory, derived from the shared root-relative URL prefix
// (`/src/algorithms`) so the watched path and the resolver's served path cannot drift.
const ALGORITHMS_SUBDIR = ALGORITHMS_DIR.slice(1);
// The override file's basename, derived from the shared root-relative path.
const OVERRIDE_BASENAME = ENGINE_OVERRIDE_PATH.slice(ALGORITHMS_DIR.length + 1);

export function algorithmsHmr(): Plugin {
  const version = createVersionCounter();
  let projectRoot = process.cwd();

  const algorithmsDir = (): string => path.resolve(projectRoot, ALGORITHMS_SUBDIR);

  // Whether the single fixed override file exists on disk.
  const overrideExists = (): boolean =>
    fs.existsSync(path.resolve(algorithmsDir(), OVERRIDE_BASENAME));

  const pingEngine = (
    target: { send(event: string, payload?: unknown): void },
    at: number,
  ): void => {
    target.send(CHANGED_EVENT, buildChangedFrame(resolveActiveFile(overrideExists()), at));
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
      // Bootstrap: resolve the active engine file and reply to the asking socket alone.
      server.ws.on(HELLO_EVENT, (_data: unknown, client): void => {
        pingEngine(client, version.current());
      });

      // Any create/change/delete under src/algorithms/ bumps the one counter and
      // re-pings every client with the freshly resolved active file. Deletes and creates
      // are watcher-only (a brand-new or vanished file is not a tracked module), so the
      // watcher is the reliable source; handleHotUpdate only suppresses the default reload.
      const onFsEvent = (file: string): void => {
        if (!isUnderAlgorithmsDir(file)) {
          return;
        }
        pingEngine(server.ws, version.bump());
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
