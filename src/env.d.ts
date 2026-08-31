/// <reference types="vite/client" />

/**
 * The assembled single engine, served by the `assemble-engine` Vite plugin
 * (`src/dev/assemble-engine-plugin.ts`) as one readable JS string. `game/engine-source.ts`
 * re-exports it as the editor default; nothing else imports the virtual id directly.
 */
declare module "virtual:engine-source" {
  export const engineSource: string;
}

// `vite/client` above types `import.meta.env` (including `.DEV`) and `import.meta.hot`,
// the dev-server HMR channel the local-IDE client rides (86-PLAN.md M2b). It also types
// `*.css`/`*.svg` and other Vite asset imports, so no manual ambient declarations are
// needed. `import.meta.env.DEV` is the one dev/production switch: the production build
// inlines it to `false` and strips the local-IDE code out.
