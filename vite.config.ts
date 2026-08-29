import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { algorithmsHmr } from "./src/dev/algorithms-hmr.ts";

/**
 * One source, one build. `vite build` emits the public `dist`; `vite` runs the dev
 * server. The dev-only local-IDE code is gated on `import.meta.env.DEV`, which the
 * production build inlines to `false`, so it strips out with no bespoke `define` or
 * mode split.
 *
 * `algorithmsHmr` is `apply: "serve"`, so it runs only on the dev server (the
 * local-IDE hot-reload loop) and is inert in the build. The worker
 * (`new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })`) is
 * bundled and served over http by Vite's built-in worker handling.
 */
export default defineConfig({
  plugins: [react(), algorithmsHmr()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    minify: true,
  },
});
