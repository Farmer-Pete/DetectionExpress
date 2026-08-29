import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { algorithmsHmr } from "./src/dev/algorithms-hmr.ts";

/**
 * One source, two build modes.
 *
 * - `vite` / `vite build --mode static` -> `dist`, `PUBLIC_DEV_KIT="false"` (the
 *   public CDN build, and the dev server, both carry no dev-kit code).
 * - `vite build --mode devkit` -> `dist-devkit`, `PUBLIC_DEV_KIT="true"` (the local
 *   dev build the host packs and serves).
 *
 * `src/game/dev-flag.ts` reads `process.env.PUBLIC_DEV_KIT`; the `define` below
 * inlines it at build time so the folded `if (DEV_KIT)` gate strips the dev-only
 * modules from the static bundle. The worker
 * (`new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })`) is
 * bundled and served over http in every mode by Vite's built-in worker handling.
 */

/**
 * Strip the dev-only guard block from the built HTML. The guard shows a "dev server
 * not running" message when index.html is opened as a file; the built site never
 * needs it. Build-only: the dev server keeps the guard.
 */
function stripDevGuard(): Plugin {
  return {
    name: "detection-express:strip-dev-guard",
    apply: "build",
    transformIndexHtml(html) {
      return html.replace(/\s*<!-- dev-guard:start[\s\S]*?dev-guard:end -->/g, "");
    },
  };
}

export default defineConfig(({ mode }) => {
  const devKit = mode === "devkit";
  return {
    // `algorithmsHmr` is `apply: "serve"`, so it runs only on the dev server (the
    // local-IDE hot-reload loop) and is inert in both builds.
    plugins: [react(), stripDevGuard(), algorithmsHmr()],
    define: {
      "process.env.PUBLIC_DEV_KIT": devKit ? '"true"' : '"false"',
    },
    build: {
      outDir: devKit ? "dist-devkit" : "dist",
      emptyOutDir: true,
      minify: true,
    },
  };
});
