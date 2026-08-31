/**
 * `assemble-engine` — the Vite plugin that serves the assembled engine as the virtual
 * module `virtual:engine-source`. It runs in serve AND build (no `apply`), so the dev
 * editor default and the production editor default are the same assembled source.
 *
 * The module exports one string, `engineSource`: the readable JS the in-game editor
 * shows and the browser run loads (`src/game/engine-source.ts` re-exports it). The
 * assembly itself lives in the pure Node module `engine-assembler.ts`; this file is
 * only the Vite wiring, so it needs no unit test of its own.
 *
 * On the dev server it watches the engine source files (the core, the endpoint
 * normalizers, and the scenario rule factories) and invalidates the virtual module on
 * any change, so editing a rule refreshes the assembled default without a restart.
 */
import path from "node:path";
import type { Plugin, ViteDevServer } from "vite";
import { assembleEngineSource } from "./engine-assembler.ts";

const VIRTUAL_ID = "virtual:engine-source";
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

/** True when a changed file is one the assembled engine is built from. */
function isEngineSource(file: string): boolean {
  const normalized = file.replace(/\\/g, "/");
  return (
    normalized.includes("/src/sim/engine/core.ts") ||
    /\/src\/sim\/endpoints\/[^/]+\/normalize\.ts$/.test(normalized) ||
    /\/src\/sim\/scenarios\/[^/]+\/rule\.ts$/.test(normalized)
  );
}

export function assembleEngine(): Plugin {
  let projectRoot = process.cwd();

  return {
    name: "detection-express:assemble-engine",

    configResolved(config): void {
      projectRoot = config.root;
    },

    resolveId(id): string | undefined {
      return id === VIRTUAL_ID ? RESOLVED_ID : undefined;
    },

    load(id): string | undefined {
      if (id !== RESOLVED_ID) {
        return undefined;
      }
      const source = assembleEngineSource(projectRoot);
      return `export const engineSource = ${JSON.stringify(source)};`;
    },

    configureServer(server: ViteDevServer): void {
      const invalidate = (file: string): void => {
        if (!isEngineSource(path.resolve(file))) {
          return;
        }
        const mod = server.moduleGraph.getModuleById(RESOLVED_ID);
        if (mod) {
          server.moduleGraph.invalidateModule(mod);
          server.ws.send({ type: "full-reload" });
        }
      };
      server.watcher.on("change", invalidate);
      server.watcher.on("add", invalidate);
      server.watcher.on("unlink", invalidate);
    },
  };
}
