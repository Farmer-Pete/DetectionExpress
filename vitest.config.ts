import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { assembleEngine } from "./src/dev/assemble-engine-plugin.ts";

/**
 * Vitest config, standalone from `vite.config.ts`.
 *
 * happy-dom supplies the DOM. `globals: false`, so each test imports `describe`,
 * `it`, `expect`, and `vi` from `vitest`.
 *
 * `assembleEngine` is registered here too so tests that import the editor default
 * (`virtual:engine-source` via `game/engine-source.ts`) resolve the same assembled
 * source the app does.
 */
export default defineConfig({
  plugins: [react(), assembleEngine()],
  test: {
    environment: "happy-dom",
    globals: false,
    setupFiles: ["src/test/cleanup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.ts"],
  },
});
