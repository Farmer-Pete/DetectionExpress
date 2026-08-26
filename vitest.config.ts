import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Two projects: the pure-TypeScript sim runs headless in Node, the React UI runs in jsdom.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "sim",
          environment: "node",
          include: ["src/sim/**/*.test.ts"],
        },
      },
      {
        plugins: [react()],
        test: {
          name: "ui",
          environment: "jsdom",
          setupFiles: ["./src/test/setup.ts"],
          include: ["src/ui/**/*.test.{ts,tsx}", "src/game/**/*.test.{ts,tsx}"],
        },
      },
    ],
  },
});
