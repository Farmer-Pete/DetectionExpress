import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Vitest config, standalone from `vite.config.ts`.
 *
 * happy-dom supplies the DOM. `globals: false`, so each test imports `describe`,
 * `it`, `expect`, and `vi` from `vitest`.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "happy-dom",
    globals: false,
    setupFiles: ["src/test/cleanup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.ts"],
  },
});
