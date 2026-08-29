# ADR 0004 — Local dev kit: one source, two builds, a same-origin host

- Status: Accepted
- Date: 2026-08-28

## Context

A player should be able to write the Algorithm in their own editor and see Correctness
respond on every save. The obvious shape is a hosted page that talks to a small local
helper over `http://localhost`. That shape does not work. A page served over https
cannot reliably reach `http://localhost`: Chrome gates it behind a Local Network Access
prompt and a preflight, and Safari blocks it as mixed content. So a hosted page and a
local watcher cannot be a dependable pair.

If the game cannot reach a local helper from a hosted origin, the game has to run
locally too. And once the game runs locally, one process may as well both serve the game
and watch the file. Same origin then removes CORS, discovery, handshakes, mixed content,
and version drift in a single stroke.

That leaves one code concern: the same source ships in two places. It is the public CDN
build, where none of the dev-kit machinery may appear, and it is the local dev build,
which carries all of it. One codebase has to produce both without the dev code leaking
into the public build.

## Decision

Ship one source that builds two deliverables, and distribute the dev build with a
single local host.

- **One flag, two builds.** `process.env.PUBLIC_DEV_KIT` splits them. Vite inlines it
  into the frontend bundle at build time through `define`. `build:static` defines it
  `"false"` for the CDN; `build:devkit` defines it `"true"` for the dev build.
  `src/game/dev-flag.ts` reads it once as `export const DEV_KIT =
  process.env.PUBLIC_DEV_KIT === "true"`. A property read is safe when unset, so an
  unconfigured build defaults to off.
- **The gate is co-located with the const.** The bundler folds `if (DEV_KIT)` at the
  const's use site, so the dynamic imports of the dev-only modules live in
  `dev-flag.ts` as `loadDevHostClient()` and `loadDevKitPanel()`. Vite evaluates the
  branch to `false` in the static build and drops both `dev-host-client` and
  `DevKitPanel` from the bundle entirely. `App.tsx` keeps only inert, null-guarded
  call-sites.
- **`verify:static` proves the strip.** It rebuilds the static bundle in memory and
  fails if either dev module is a rendered module of the static build's chunk graph, or
  if the dev-host endpoint strings (`api/algorithm`, `algorithm/events`) appear in the
  emitted JS. It runs in CI.
- **One local host, same origin.** `dd-dev.mjs` is a zero-dependency Node script
  that serves the packaged dev build over loopback and manages the player's Algorithm
  files: create, watch, and open. Source flows to the browser over same-origin
  Server-Sent Events, scoped per Scenario by `?slug=`. The game learns the host is
  present from the compile-time flag, not from a magic route.
- **Distribution: local now, published later.** `dd-dev.mjs` is the `bin` of the
  `detection-express` package, with the dev build packed beside it under `dist-devkit`.
  Today the developer runs it from the repo (`pnpm run build:devkit && node dd-dev.mjs`)
  and opens the printed URL. The package stays `private`; the public one-command
  install (`pnpm dlx detection-express`) is a deferred follow-up, because `pnpm dlx`
  installs from npm not git and a git install will not build the assets without trust —
  so an npm publish is the clean route when we choose it. The host resolves its assets
  relative to itself, so it works from any working directory.

## Consequences

Good:

- Same origin removes CORS, service discovery, handshakes, mixed content, and
  client/server version drift. The browser rules that block a hosted page from
  `localhost` never apply, because there is no cross-origin hop.
- The public CDN build carries no dev-kit code. The metafile check makes that a
  build-time guarantee, not a hope.
- The host adds no dependencies. It is one file on Node built-ins, so the supply
  chain and the offline story stay intact.

Costs and risks:

- Two build outputs and a publish step exist where there was one build. The `build:static`
  and `build:devkit` scripts and the `prepack` hook that packs the dev build are the
  price of the split.
- The dev build carries one dynamic edge from `game/` to `ui/` (the panel loader in
  `dev-flag.ts`). It is a dynamic import that the static build folds away, so it never
  reaches the public bundle, but it is a layering wrinkle in the dev build.
- The dev kit trusts the player. The host writes and opens files on their disk, on the
  same trust as running the kit at all. It is confined to loopback, a same-origin guard,
  a validated logical name (never a client filename), and a fixed route set.

## Reversal path (READ THIS IF THE DEV KIT IS PULLED)

The static build and the CDN path stand alone. Nothing in `sim/`, the run controller, or
the engine depends on the dev kit; the shared store holds only the generic `sourceLocked`
flag, always false in the static build.

To remove the dev kit:

1. Delete `dd-dev.mjs`, `src/game/dev-host-client.ts`, and `src/ui/DevKitPanel.tsx`,
   with their tests.
2. Drop `loadDevHostClient` and `loadDevKitPanel` from `dev-flag.ts`, and the inert
   dev-client wiring from `App.tsx`. Keep `DEV_KIT` only if a later dev feature needs it.
3. Remove `build:devkit`, `verify:static`, the `bin`, `files`, and `prepack` entries from
   `package.json`, and the `verify:static` CI step. Rename `build:static` back to `build`
   if the two-build split is no longer wanted.
4. Leave `sourceLocked` in the store, or remove it and the editor's read-only branch. It
   is harmless either way.

The static build keeps working untouched throughout, so the dev kit can be pulled without
a rewrite.
