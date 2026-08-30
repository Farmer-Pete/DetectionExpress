/// <reference types="vite/client" />

// `vite/client` above types `import.meta.env` (including `.DEV`) and `import.meta.hot`,
// the dev-server HMR channel the local-IDE client rides (86-PLAN.md M2b). It also types
// `*.css`/`*.svg` and other Vite asset imports, so no manual ambient declarations are
// needed. `import.meta.env.DEV` is the one dev/production switch: the production build
// inlines it to `false` and strips the local-IDE code out.
