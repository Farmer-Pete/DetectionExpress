import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Vitest config, standalone so it does NOT inherit the `define` from
 * `vite.config.ts`. Tests must read `process.env.PUBLIC_DEV_KIT` at runtime (set by
 * the `src/test/dev-kit-flag.ts` setup file), not a build-time-inlined literal, so
 * `dev-flag.test.ts` can pin the dev branch on.
 *
 * happy-dom supplies the DOM. `globals: false`, so each test imports `describe`,
 * `it`, `expect`, and `vi` from `vitest`.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "happy-dom",
    globals: false,
    setupFiles: ["src/test/dev-kit-flag.ts", "src/test/cleanup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.ts", "dd-dev.test.mjs"],
  },
});
