/// <reference types="vite/client" />

// `vite/client` above types `import.meta.env` (including `.DEV`) and `import.meta.hot`,
// the dev-server HMR channel the local-IDE client rides (86-PLAN.md M2b). It also types
// `*.css`/`*.svg` and other Vite asset imports, so the manual ambient declarations below
// are gone.

// The dev-kit flag is read as `process.env.PUBLIC_DEV_KIT` (dot form), which Vite
// inlines at build time via `define`. Declaring it a real property lets TypeScript
// accept the dot access under `noPropertyAccessFromIndexSignature`, and Vite still
// replaces the literal expression.
declare namespace NodeJS {
  interface ProcessEnv {
    PUBLIC_DEV_KIT?: string;
  }
}
