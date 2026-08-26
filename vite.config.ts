import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// Removes the dev-only guard block from index.html in production builds, so
// dist/index.html never carries the "dev server not running" fallback.
function stripDevGuard(): Plugin {
  return {
    name: "strip-dev-guard",
    apply: "build",
    transformIndexHtml(html) {
      return html.replace(/\s*<!-- dev-guard:start[\s\S]*?dev-guard:end -->/g, "");
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), stripDevGuard()],
});
