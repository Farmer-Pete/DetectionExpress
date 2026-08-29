# ADR 0007 — Native algorithm hot-reload on one dev server

- Status: Accepted
- Date: 2026-08-29
- Supersedes the local dev kit (the standalone same-origin host and the two-build split).
- Renumbered from `0004-local-dev-kit` to resolve the duplicate `0004` (shared with
  `0004-measured-cost-model`). Closes the housekeeping note in ADR 0006.

## Context

A player writes the Algorithm two ways. They type it in the in-game editor, or they install
the game and edit a file in their own editor. Both modes ran JavaScript only, because the
browser imports the source as a module and executes it verbatim, and a browser cannot run
TypeScript. Players wanted TypeScript, for real type checking and editor help.

The old local dev kit met the "bring your own editor" need with a standalone same-origin host
(`dd-dev.mjs`). It served a separate built bundle over loopback and streamed the edited file
to the browser over Server-Sent Events. That worked, but it stood up a second dev server
beside Vite, and it hand-rolled a transport: a socket, per-file framing, and its own ordering.

Two forces pushed past it. First, the zero-dependency constraint that justified a standalone
host fell away once we accepted that a local player installs the whole repo anyway. Second, a
long design review of a websocket side-channel kept surfacing concurrency bugs — out-of-order
compiles, late frames, session identity — the very problems a real module system already
solves. The lesson was to stop rebuilding a transport and use the one Vite already has.

## Decision

Serve TypeScript algorithms as native Vite modules, hot-reloaded, on one dev server.

- **One dev server.** Vite is the only dev server. Retire `dd-dev.mjs` and the two-build
  split. `pnpm run dev` serves both game development and local-IDE authoring.
- **Local algorithms are real modules.** A player edits `src/algorithms/<slug>.ts` in their
  own editor. Vite strips the types with esbuild and serves it. Real imports give real types,
  so there is no hand-written declaration file to maintain.
- **The in-game editor stays JavaScript.** It runs a source string through a Blob import, as
  before. The public CDN site does not change and ships no transpiler.
- **The default engine is checked in, outside the player folder.** It lives at
  `src/game/default-engine.ts` so anti-slop lint covers it; Biome cannot lint a gitignored
  file. `src/algorithms/` is player scratch space, gitignored whole, so no player file is
  committed by accident.
- **The mechanism is a thin change notification, not a protocol.** A dev-only plugin watches
  `src/algorithms/*` and holds one monotonic version counter. It answers `algo:hello { slug }`
  by resolving the active file (`src/algorithms/<slug>.ts` if it exists, else the default
  engine) and replies `algo:changed { slug, path, version }`. On any change it re-resolves and
  pings. The client re-imports the versioned URL and runs the module.

```text
  player saves src/algorithms/<slug>.ts
        │  Vite recompiles (esbuild strips types)
        v
  plugin -> one ping: algo:changed { slug, path, version }
        │  client: my slug?
        v
  client re-imports  import(path + "?v=" + version)   (cache-bust, fresh code)
        │
        +--> run controller: run() awaits the load inside its generation guard
        +--> profiler Worker: imports the same versioned URL
```

- **One controller input.** The run controller consumes an `AlgorithmSource`: url mode for a
  local module, source mode for the in-game string. From it the controller derives the loader,
  the profiler request, and the calibration cache key. The existing generation guard keeps a
  reordered load from winning. A compile error rejects the import and lands on the existing
  load-error path.
- **Type safety comes from the editor.** `tsconfig` includes `src`, so the player's editor and
  `pnpm run typecheck` check `src/algorithms/*` live. There is no in-app type-check panel.

Two browser prototypes de-risked the parts unit tests cannot reach, in Chrome and Firefox: a
module Worker importing a Vite-served module (the profiler measuring a module), and the ping
plus cache-bust loop delivering fresh code on save with no page reload.

## Consequences

Good:

- One dev server and one build. The hand-rolled transport is gone, and with it a class of
  concurrency bugs; Vite owns ordering and delivery.
- Real TypeScript with real imports. Multi-file algorithms load, because native modules
  resolve imports.
- Editing an algorithm hot-reloads the run with no page reload.
- Less code to keep: the standalone host, the SSE client, the dev-kit panel, and the
  two-build machinery are deleted.

Costs and limits:

- Creating or deleting the active override each force one page reload, because the module
  graph changes. Edits, the common case, are seamless. After the reload the client re-enters
  local mode from `sessionStorage` and resolves the correct file.
- Hot-reload of a helper-file edit is a follow-up. v1 re-imports the entry file; a helper
  change needs an entry save or a reload.
- The default engine lives outside `src/algorithms/` so lint can see it. That splits the
  "default" from the "player" files by folder.
- Line-accurate crash locations are a follow-up; a runtime error reports a message, as the
  in-game editor already does.

## Reversal path

The static build and the public site do not depend on any of this; the dev path is behind
`import.meta.env.DEV` and tree-shakes out. `verify:static` proves the dev client, the plugin,
and the `algo:` events are absent from the production bundle. The url-mode loader branch in
`algorithm.ts` is still bundled, but it is unreachable in production: its only trigger,
`store.localAlgorithm`, is set solely by the DEV-gated dev client, so production always runs
the in-game source path. To pull the local-IDE feature: delete `src/dev/algorithms-hmr.ts`,
`src/game/algorithms-dev-client.ts`, and `src/game/algorithms-dev-flag.ts`, drop the
`algorithmsHmr()` plugin and the dev wiring in `App.tsx`, and keep or remove
`store.localAlgorithm` and the default engine as suits. The in-game editor keeps working
throughout.
