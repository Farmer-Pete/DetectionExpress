# ADR 0005 — Move the toolchain to Node, drop Bun

- Status: Accepted
- Date: 2026-08-28
- Supersedes: [ADR 0001](0001-all-bun-drop-vite.md)

## Context

ADR 0001 put the whole toolchain on Bun: runtime, package manager, test runner, and
HTML bundler. One job never worked. The profiler runs the player's rule in a Web
Worker built from `new Worker(new URL("./worker.ts", import.meta.url), { type:
"module" })`, and Bun's HTML bundler never wires that worker, so it never loads over
http (Bun issue #18601, open). That is GH-22: the measured-cost model cannot run off
the main thread on the shipped build.

The dev kit already runs a Node host (`dd-dev.mjs`). So the project ran two runtimes
in practice, and the one thing Bun's bundler owed us — a wired worker — was the one
thing it did not deliver.

## Decision

Reverse ADR 0001. Use one Node toolchain for install, dev, build, and test.

- **Runtime:** Node 26.5.1, pinned in `.nvmrc` and in CI.
- **Package manager:** pnpm 10.29.3 (the `packageManager` field). The supply-chain
  cooldown moves from bunfig's `minimumReleaseAge` (seconds) to pnpm's
  `minimumReleaseAge` in `pnpm-workspace.yaml` (minutes: 10080 = 7 days), with an
  empty `minimumReleaseAgeExclude`.
- **Dev server and bundler:** Vite. `pnpm run dev` serves; `vite build --mode static`
  builds `dist` and `--mode devkit` builds `dist-devkit`. `PUBLIC_DEV_KIT` is set
  through Vite's `define`. A `strip-dev-guard` build plugin removes the dev-only HTML
  guard, replacing `scripts/postbuild.ts`. Vite bundles the worker and serves it over
  http in every mode, which closes GH-22.
- **Test runner:** Vitest on the happy-dom environment. The `bun:test` imports move to
  `vitest`; the happy-dom global registrator is dropped (the environment supplies the
  DOM). Pure-Node tests (the dev host, the dev-flag source read) declare the `node`
  environment.
- **Scripts:** `tsx` runs the TypeScript scripts. `verify:static` rebuilds the static
  bundle in memory with Vite and inspects the chunk graph; new `verify:worker-build`
  and `pack:check` scripts assert the worker is bundled and wired and that the dev-kit
  tarball is complete.

## The blob-loader seam

`loadAlgorithm` imported the player's source as a `blob:` module. Bun ran that
in-process under `bun test`; Node's ESM loader rejects `blob:` imports, so the test
could not run in a Node process. The loader is split: a pure `adaptModule(loaded)`
validates and normalizes a plain module object (Node-testable), and a thin
`loadAlgorithm(source, importSource = defaultImportSource)` does the blob import
through an injectable seam. The browser-only blob shell is covered by the app and the
manual worker smoke, not a Node unit test.

## Consequences

Good:

- The worker loads over http in dev, in the static build, and in the devkit build.
  GH-22 is closed, and a build-output assertion (`verify:worker-build`) guards it.
- Vitest gives a per-file environment, so pure-logic tests need not carry a DOM.
- Vite's plugin ecosystem is available if a future need wants it.

Costs and risks:

- More moving parts than one tool: Vite, Vitest, and tsx where Bun did all three.
- The build output type follows Vite's engine (Vite 8 is Rolldown-based). The verify
  scripts read the Rollup-compatible chunk fields (`fileName`, `modules`, `code`), so
  they hold across the engine choice, and each has a fixture-backed unit test.
- The blob shell is not Node-unit-tested. Documented gap, covered in the browser.

## Reversal path

`origin/main` before this ADR's commit is the Bun baseline; ADR 0001's reversal path
describes the Bun setup in full. To go back, restore `bunfig.toml`, `bun.lock`, and
the `@types/bun` and happy-dom registrator dependencies, point the scripts and CI at
Bun, and change the `vitest` imports back to `bun:test`. There is no data or migration
to unwind.
