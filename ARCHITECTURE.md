# Architecture

This file sets the rules for how the code is shaped. Read it before you write game code.
`CONTEXT.md` holds the domain vocabulary. `PLAN.md` holds the build plan. This file holds the boundaries.

## The core split

The simulation is pure TypeScript. The UI is React. They never blur together.

```
   Player input                          Live snapshot (10-30 Hz)
        │                                          ▲
        ▼                                          │
   ┌─────────┐        reads topology        ┌──────────────┐
   │  ui/    │ ───────────────────────────► │   sim/       │
   │ React   │                              │  pure TS     │
   │         │ ◄─────── snapshot ────────── │  no DOM      │
   └─────────┘                              └──────────────┘
        ▲                                          ▲
        │                 game/                    │
        └──────── glue: run loop + store ──────────┘
```

## Folders

| Folder      | Holds                                                        | May import React? |
| ----------- | ----------------------------------------------------------- | ----------------- |
| `src/sim/`  | The Engine, Events, Rules, the tick. Pure logic.            | No. Never.        |
| `src/game/` | The glue: the run loop and the store that bridges sim to UI. | Only the store.   |
| `src/ui/`   | React components, gauges, panels, the React Flow canvas.     | Yes.              |

## The rules

1. **The sim owns the loop. React never drives it.** The loop lives in a plain-TS module in `src/game/`. A `useEffect` starts and stops it. Render never ticks the sim.

2. **The sim is a real-time async pipeline driven by one Clock.** Nodes are async tasks. Events flow over a `Channel` between nodes, with backpressure. One Clock owns time, pause, and stop, and every wait goes through it. (Part 0 note: the Sink uses a short `sleep` to fake a slow node. That sleep is temporary. It goes away once players write their own node code, and the pipeline stays async but becomes deterministic.)

3. **A sampler publishes one atomic snapshot.** A 10 to 30 Hz sampler reads the running pipeline and writes a single immutable snapshot. React never reads half-updated state.

4. **React subscribes through an external store.** Read the snapshot with `useSyncExternalStore` or a store like Zustand. Never hold fast-changing sim state in `useState`. That re-renders the tree every tick.

5. **Throttle the UI.** Push snapshots to the HUD at about 10 to 30 Hz, even when the sim ticks faster. The eye does not need 60 Hz gauges.

6. **The graph is the single source of topology.** The player edits nodes and edges in the store. The sim reads that graph as its wiring. Do not copy the graph into a second sim-only structure. Two truths drift apart.

7. **No ECS.** For dozens of Nodes and Events, plain typed modules with arrays and maps win. Revisit only if entity counts reach the thousands.

8. **Game clock only.** Time is the game Clock's ticks. The sim and the scorer use game-time values only (Clock ticks, scheduled Event timestamps, a processed watermark). Never use wall-clock time (`Date.now`, `performance.now`, `setInterval` durations) in sim or scoring logic. Render animations may pace with `requestAnimationFrame`, but never feed wall time back into the sim.

   **The one measured cost lives outside the sim (Slice 2).** The engine must know how much
   work a player's Rule does per Event, and it cannot read that from the game Clock: a
   synchronous `match()` fires no tick, so `now()` reads the same before and after it. So a
   profiler measures the player's code throughput off the sim, normalizes it against a
   detection-shaped anchor (`C/A`), and quantizes it to a fixed rational service rate. That
   rate is the only cost the sim consumes, and it stays constant for the whole run. The
   measurement runs in a Web Worker, with a main-thread fallback where a module Worker cannot
   be constructed. Every wall-clock read (`performance.now`) lives in that profiler. The sim
   loop still holds no wall-clock.

   The trade: cross-machine determinism is relaxed. A seed is not the exact same challenge on
   a fast box and a slow box, because the service rate is measured per machine. Per-machine
   replay still holds, because the rate is fixed before the run starts. See
   `docs/adr/0004-measured-cost-model.md` for the decision and its limits.

   ```
     edit time (Web Worker, off the sim)        run time (sim loop, game ticks)
       measure C/A, quantize serviceRate   -->    charge a fixed cost per Event
       performance.now lives here                 no wall-clock; ticks only
   ```

## Folders for content

- `src/sim/endpoints/` holds reusable Endpoints. Each family keeps one internal record type and generates it once; each Endpoint is a thin formatter over it. Pure logic, no React. Endpoints are shared across Scenarios.
- `src/sim/scenarios/` holds one folder per Scenario. A Scenario composes Endpoints, drives the intent timeline, injects Attacks, and records the Ground truth. Pure logic, no React.
- The player's Algorithm is an ES module the engine imports at runtime. A run controller in `src/game/` owns its edit, load, and reload lifecycle.
- Two ways to author it. The in-game editor holds a JavaScript source string. Or a player edits a real TypeScript module at `src/algorithms/<slug>.ts` in their own editor, and Vite hot-reloads it into the run. `src/algorithms/` is gitignored player scratch space; the checked-in default engine lives at `src/game/default-engine.ts`. See `docs/adr/0007-native-algorithm-hot-reload.md`.

## Toolchain

- **Node** (26.5.1, pinned in `.nvmrc` and CI) is the runtime. **pnpm** (10.29.3) is the
  package manager, with a 7-day install cooldown in `pnpm-workspace.yaml`.
- **Vite** is the only dev server and the bundler. Dev server: `pnpm run dev`, which also
  serves and hot-reloads local-IDE algorithms. Build: `pnpm run build` (to `dist`). Vite
  bundles the profiler Web Worker and serves it over http. The dev-only local-IDE code is
  behind `import.meta.env.DEV` and drops from the build; `verify:static` proves it.
- **Vitest** (happy-dom) is the test runner; **tsx** runs the TypeScript scripts.
- See `docs/adr/0005-node-toolchain-drop-bun.md` for the move to Node, and
  `docs/adr/0001-all-bun-drop-vite.md` (Superseded) for the Bun era it reverses.

## Testing

- The test runner is `vitest` (happy-dom environment; see `vitest.config.ts`).
- Test the transforms, the `Channel`, and the rate and heat math as pure functions. They need no DOM.
- Keep real time out of the tests. Give the Sink an injectable delay, not a real clock. Drive the `Channel` by hand and assert on counts, rates, and heat.
- Test React parts with `@testing-library/react`. happy-dom provides the DOM.

## React Flow

- React Flow (`@xyflow/react`) lands in Slice 0, not before.
- Keep it controlled. Nodes and edges live in the store, not in component state.
- Every change to the `nodes` array re-renders dependent components. So memoize custom nodes. Use store selectors to feed live data into one node without re-rendering the whole graph.

## Anti-slop

- Biome is the linter and formatter. The `biome-anti-slop` GritQL rules live in `tools/biome/anti-slop/`. They reject low-evidence TypeScript.
- TypeScript runs at maximum strictness.
- Knip flags dead code and unused dependencies.
- These gates run on pre-commit, pre-push, and in CI.
