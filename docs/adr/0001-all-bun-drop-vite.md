# ADR 0001 — Use Bun for the whole toolchain, drop Vite

- Status: Superseded by [ADR 0005](0005-node-toolchain-drop-bun.md)
- Date: 2026-08-26

> Superseded on 2026-08-28. Bun's HTML bundler never wired the profiler Web Worker
> (GH-22), so the toolchain moved to Node, Vite, and Vitest. This ADR's "reversal
> path" is the route that was taken; ADR 0005 records the decision. The context
> below is kept as history.

## Context

The project started on the conventional pairing: Bun as runtime and package
manager, Vite as dev server and bundler, Vitest as the test runner. Bun and Vite
overlap on one job, bundling and serving. During setup we asked whether we need
both.

Bun (1.4) now ships a full frontend path of its own:

- `bun ./index.html` runs a dev server that bundles and transpiles TSX with hot
  reload.
- `bun build ./index.html --outdir dist` produces a static site with hashed assets.
- `bun test` runs tests, with happy-dom for a DOM.

## Decision

Use Bun for the entire toolchain. Remove Vite and Vitest.

- Dev server: `bun ./index.html`.
- Production build: `bun build ./index.html --minify --outdir dist`, then a small
  post-build script strips the dev-only guard from the HTML.
- Tests: `bun test`, with a happy-dom preload (`bunfig.toml`) and
  `@testing-library/react`.

Dropping Vite forces dropping Vitest, since Vitest is built on Vite. The test
runner therefore moved to `bun test`, and test imports moved from `vitest` to
`bun:test`.

## Consequences

Good:

- One tool for install, run, test, and build. Fewer dependencies, less config.
- Faster installs and startup.

Costs and risks:

- Bun's frontend bundler and dev server are newer than Vite's. React Fast Refresh
  and edge-case bundling are less battle-tested.
- We lose Vite's large plugin ecosystem. If a future need wants a Vite plugin, we
  would have to find a Bun equivalent or write one.
- `bun test` has one global environment, not Vite's per-project split. happy-dom
  is registered for every test, including pure-logic sim tests. This is harmless
  but less strict than the old Node-vs-jsdom separation.

## Reversal path (READ THIS IF BUN MISBEHAVES)

Going back to Vite is expected to be straightforward and is a supported fallback.
Reverse this ADR if we hit Bun frontend bugs we cannot work around: broken HMR or
React Fast Refresh, bundler output problems, or `bun test` DOM gaps.

To revert:

1. Add back `vite`, `@vitejs/plugin-react`, `vitest`, `jsdom`, and
   `@testing-library/jest-dom`. Remove `@happy-dom/global-registrator`.
2. Restore `vite.config.ts` and `vitest.config.ts`, and the split
   `tsconfig.app.json` / `tsconfig.node.json`.
3. Point scripts back: `dev` to `vite`, `build` to `tsc -b && vite build`, `test`
   to `vitest run`.
4. Change test imports from `bun:test` back to `vitest`, and restore the
   Vite-plugin form of the dev-guard strip (`transformIndexHtml`, `apply: build`).
5. Keep Bun as the runtime and package manager. Only the dev/build/test layer
   returns to Vite.

The Vite-based setup is preserved in git history before this ADR's commit, so
`git show` on the pre-migration commits is the fastest reference.
