import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { assembleEngine } from "./src/dev/assemble-engine-plugin.ts";

/**
 * One source, one build. `vite build` emits the public `dist`; `vite` runs the dev
 * server.
 *
 * `assembleEngine` runs in serve AND build: it serves the assembled single engine as
 * the `virtual:engine-source` module, so the editor default is the same source in dev
 * and in the production build. `verify:static` asserts it ships.
 */
export default defineConfig({
  plugins: [react(), assembleEngine()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    minify: true,
  },
});
