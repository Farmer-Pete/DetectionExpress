/// <reference types="vite/client" />

/**
 * The assembled single engine, served by the `assemble-engine` Vite plugin
 * (`src/dev/assemble-engine-plugin.ts`) as one readable JS string. `game/engine-source.ts`
 * re-exports it as the editor default; nothing else imports the virtual id directly.
 */
declare module "virtual:engine-source" {
  export const engineSource: string;
}

// `vite/client` above types `import.meta.env` and `*.css`/`*.svg` and other Vite asset
// imports, so no manual ambient declarations are needed for those.
